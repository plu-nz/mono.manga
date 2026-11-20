import type { ChapterSummary, MangaDetails, MangaProvider, PageRef, SearchResult } from '../../core/types';
import { ProviderError } from '../errors';
import { parseChapterList, parseSearchResults } from './parse';
import { extraAuthHeader } from './session';

/**
 * Weeb Central, used only to fill chapters missing from a title's provider.
 * Requests go through the Worker, which serves them to signed-in accounts.
 */

const BASE = '/api/weebcentral';
export const WEEBCENTRAL_NAME = 'Weeb Central';

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  const auth = await extraAuthHeader();
  if (!auth) throw new ProviderError('unauthorized', 'Extra sources are locked');
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { headers: auth, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ProviderError('network', 'Weeb Central relay unreachable', { cause: error });
  }
  if (response.ok) return response;
  if (response.status === 401) throw new ProviderError('unauthorized', 'Session rejected', { status: 401 });
  if (response.status === 404) throw new ProviderError('not_found', 'Not found', { status: 404 });
  if (response.status === 429) throw new ProviderError('rate_limited', 'Rate limited', { status: 429, retryAfter: 60 });
  throw new ProviderError('upstream', `Relay error ${response.status}`, { status: response.status });
}

/** Chapters of a Weeb Central series, attached to the title they fill. */
export async function fetchSourceChapters(
  seriesId: string,
  title: { provider: ChapterSummary['provider']; id: string },
  signal?: AbortSignal,
): Promise<ChapterSummary[]> {
  const html = await (await request(`/series/${encodeURIComponent(seriesId)}/chapters`, signal)).text();
  return parseChapterList(html).map(chapter => ({
    provider: title.provider,
    mangaId: title.id,
    id: chapter.id,
    ...(chapter.number ? { number: chapter.number } : { title: chapter.label }),
    language: 'en',
    // The page count is only known when the chapter opens; any positive value marks it readable.
    pages: 1,
    ...(chapter.publishedAt ? { publishedAt: chapter.publishedAt } : {}),
    groups: [WEEBCENTRAL_NAME],
    source: 'weebcentral',
  }));
}

export const weebCentralProvider: MangaProvider = {
  id: 'weebcentral',
  name: WEEBCENTRAL_NAME,
  // Not listed in the main search: it only fills chapters of linked titles.
  capabilities: { search: false, updates: false },
  async search(query, signal): Promise<SearchResult> {
    const text = query.text.trim().slice(0, 100);
    const html = await (await request(`/search?q=${encodeURIComponent(text)}`, signal)).text();
    const items = parseSearchResults(html);
    return { items, total: items.length, offset: 0, limit: items.length };
  },
  async getManga(id): Promise<MangaDetails> {
    throw new ProviderError('not_found', `Weeb Central titles are not opened directly (${id})`);
  },
  async getChapters(mangaId, _options, signal) {
    return fetchSourceChapters(mangaId, { provider: 'weebcentral', id: mangaId }, signal);
  },
  async getPages(chapterId, _options, signal): Promise<PageRef[]> {
    const data = (await (await request(`/chapters/${encodeURIComponent(chapterId)}/pages`, signal)).json()) as { pages?: string[] };
    return (data.pages ?? []).map((url, index) => ({ index, url }));
  },
};
