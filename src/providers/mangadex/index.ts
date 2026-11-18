/**
 * MangaDex provider. JSON goes through this app's Worker (`/api/mangadex`)
 * because MangaDex sends no CORS headers to other sites; images go through
 * the Worker too because MangaDex serves a placeholder to third-party
 * origins and its policy requires proxying them.
 */
import type { ChapterSummary, MangaDetails, MangaProvider, PageRef, SearchResult } from '../../core/types';
import { ProviderError } from '../errors';
import { createApiClient, type AtHomeServer, type ChapterEntity, type Collection, type Entity, type MangaEntity, type Params } from './api';
import { mapChapter, mapDetails, mapSummary, sortChapters, toMangaDexDate, type CoverUrlBuilder } from './map';
import { MANGADEX_ATTRIBUTION } from './policy';

export { MANGADEX_ATTRIBUTION, mangaDexChapterUrl, mangaDexTitleUrl } from './policy';

export interface MangaDexProviderOptions {
  /** Path or URL of the Worker proxy. Default `/api/mangadex`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * Origin used to make proxied image URLs absolute. Defaults to
   * `location.origin` when available (pages, web workers).
   */
  origin?: string;
  /**
   * Point covers and pages at MangaDex directly instead of the proxy. Only
   * useful for non-browser clients: browsers on other origins get a
   * placeholder image.
   */
  directImages?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALL_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];
const DEFAULT_RATINGS = ['safe', 'suggestive'];
const FEED_PAGE = 500;
const LIST_PAGE = 100;
/** MangaDex rejects collection requests where offset + limit exceeds 10 000. */
const MAX_WINDOW = 10_000;
const MANGA_INCLUDES: Params = [['includes[]', 'cover_art'], ['includes[]', 'author'], ['includes[]', 'artist']];
/** Concurrent feed requests while checking updates; MangaDex allows ~5 req/s per IP. */
const UPDATE_CONCURRENCY = 2;

function many(key: string, values: readonly string[]): Params {
  return values.map(value => [key, value]);
}

function assertUuid(id: string): void {
  if (!UUID.test(id)) throw new ProviderError('not_found', `Not a MangaDex id: ${id}`);
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function defaultOrigin(): string | undefined {
  const location = (globalThis as { location?: { origin?: string } }).location;
  return location?.origin && location.origin !== 'null' ? location.origin : undefined;
}

export function createMangaDexProvider(options: MangaDexProviderOptions = {}): MangaProvider {
  const baseUrl = (options.baseUrl ?? '/api/mangadex').replace(/\/+$/, '');
  const api = createApiClient(baseUrl, options.fetch ?? ((input, init) => fetch(input, init)));
  const origin = options.origin ?? defaultOrigin();
  const absolute = (path: string) => (/^https?:\/\//i.test(path) || !origin ? path : new URL(path, origin).toString());

  const coverUrl: CoverUrlBuilder = (mangaId, fileName) =>
    options.directImages
      ? `https://uploads.mangadex.org/covers/${mangaId}/${fileName}`
      : absolute(`${baseUrl}/covers/${mangaId}/${encodeURIComponent(fileName)}`);

  const pageUrl = (server: AtHomeServer, quality: 'data' | 'data-saver', file: string) =>
    options.directImages
      ? `${server.baseUrl.replace(/\/+$/, '')}/${quality}/${server.chapter.hash}/${file}`
      : absolute(`${baseUrl}/page/${quality}/${server.chapter.hash}/${encodeURIComponent(file)}?base=${encodeURIComponent(server.baseUrl)}`);

  async function feedPage(mangaId: string, params: Params, offset: number, signal?: AbortSignal) {
    return api.get<Collection<ChapterEntity>>(`manga/${mangaId}/feed`, [...params, ['limit', FEED_PAGE], ['offset', offset]], signal);
  }

  const provider: MangaProvider = {
    id: 'mangadex',
    name: 'MangaDex',
    attribution: MANGADEX_ATTRIBUTION,
    capabilities: { search: true, updates: true },

    async search(query, signal): Promise<SearchResult> {
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), LIST_PAGE);
      const offset = Math.min(Math.max(Math.trunc(query.offset ?? 0), 0), MAX_WINDOW - limit);
      const text = query.text.trim();
      const ratings = query.contentRating?.length ? query.contentRating : DEFAULT_RATINGS;
      const result = await api.get<Collection<MangaEntity>>('manga', [
        ['title', text || undefined],
        ['limit', limit],
        ['offset', offset],
        ...MANGA_INCLUDES,
        ...many('contentRating[]', ratings),
        ...many('availableTranslatedLanguage[]', query.languages ?? []),
        // Without text, relevance is meaningless: show popular titles instead.
        text ? ['order[relevance]', 'desc'] : ['order[followedCount]', 'desc'],
      ], signal);
      return {
        items: result.data.map(manga => mapSummary(manga, coverUrl)),
        total: Math.min(result.total, MAX_WINDOW),
        offset: result.offset,
        limit: result.limit,
      };
    },

    async getManga(id, signal): Promise<MangaDetails> {
      assertUuid(id);
      const result = await api.get<Entity<MangaEntity>>(`manga/${id}`, MANGA_INCLUDES, signal);
      return mapDetails(result.data, coverUrl);
    },

    async getChapters(mangaId, { languages }, signal): Promise<ChapterSummary[]> {
      assertUuid(mangaId);
      const params: Params = [
        ...many('translatedLanguage[]', languages),
        ['order[volume]', 'asc'],
        ['order[chapter]', 'asc'],
        ['includes[]', 'scanlation_group'],
        ...many('contentRating[]', ALL_RATINGS),
        // Tri-state filters: absent = both, 1 = only, 0 = exclude. `includeExternalUrl` is
        // deliberately absent so official external chapters are listed alongside hosted ones.
        ['includeFuturePublishAt', 0],
      ];
      const chapters: ChapterSummary[] = [];
      let offset = 0;
      for (;;) {
        const page = await feedPage(mangaId, params, offset, signal);
        for (const entity of page.data) {
          const chapter = mapChapter(entity, mangaId);
          if (chapter) chapters.push(chapter);
        }
        offset += page.data.length;
        if (page.data.length === 0 || offset >= page.total || offset + FEED_PAGE > MAX_WINDOW) break;
      }
      return sortChapters(chapters);
    },

    async getPages(chapterId, { dataSaver }, signal): Promise<PageRef[]> {
      assertUuid(chapterId);
      const server = await api.get<AtHomeServer>(`at-home/server/${chapterId}`, [], signal);
      const { data = [], dataSaver: saver = [] } = server.chapter;
      const [primary, primaryFiles, secondary, secondaryFiles] = dataSaver && saver.length
        ? (['data-saver', saver, 'data', data] as const)
        : (['data', data, 'data-saver', saver] as const);
      return primaryFiles.map((file, index): PageRef => {
        const other = secondaryFiles[index];
        return {
          index,
          url: pageUrl(server, primary, file),
          ...(other ? { fallbackUrl: pageUrl(server, secondary, other) } : {}),
        };
      });
    },

    /**
     * MangaDex cannot list chapters for many titles in one public request
     * (`/chapter` takes a single `manga`). To stay polite, look up each
     * title's latest uploaded chapter in batches of 100, then read the feed
     * only for titles that changed since `since`.
     */
    async getUpdates(mangaIds, { languages, since }, signal): Promise<ChapterSummary[]> {
      const sinceDate = toMangaDexDate(since);
      const sinceTime = Date.parse(`${sinceDate}Z`);
      const ids = [...new Set(mangaIds.filter(id => UUID.test(id)))];
      const changed: string[] = [];
      for (const batch of chunks(ids, LIST_PAGE)) {
        const titles = await api.get<Collection<MangaEntity>>('manga', [
          ...many('ids[]', batch),
          ['limit', LIST_PAGE],
          ...many('contentRating[]', ALL_RATINGS),
        ], signal);
        const latest = new Map<string, string>();
        for (const manga of titles.data) {
          const chapterId = manga.attributes.latestUploadedChapter;
          if (chapterId) latest.set(chapterId, manga.id);
        }
        if (!latest.size) continue;
        const recent = await api.get<Collection<ChapterEntity>>('chapter', [
          ...many('ids[]', [...latest.keys()]),
          ['limit', LIST_PAGE],
          ...many('contentRating[]', ALL_RATINGS),
        ], signal);
        for (const chapter of recent.data) {
          const { publishAt, readableAt, createdAt } = chapter.attributes;
          const newest = Math.max(...[publishAt, readableAt, createdAt].map(value => (value ? Date.parse(value) : 0)));
          const mangaId = latest.get(chapter.id);
          if (mangaId && newest > sinceTime) changed.push(mangaId);
        }
      }

      const params: Params = [
        ['publishAtSince', sinceDate],
        ...many('translatedLanguage[]', languages),
        ['order[publishAt]', 'desc'],
        ['includes[]', 'scanlation_group'],
        ...many('contentRating[]', ALL_RATINGS),
        ['includeFuturePublishAt', 0],
        ['limit', LIST_PAGE],
      ];
      const updates: ChapterSummary[] = [];
      let next = 0;
      const worker = async () => {
        while (next < changed.length) {
          const mangaId = changed[next++];
          const page = await api.get<Collection<ChapterEntity>>(`manga/${mangaId}/feed`, params, signal);
          for (const entity of page.data) {
            const chapter = mapChapter(entity, mangaId);
            if (chapter) updates.push(chapter);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPDATE_CONCURRENCY, changed.length) }, worker));
      return updates.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.id.localeCompare(b.id));
    },
  };
  return provider;
}
