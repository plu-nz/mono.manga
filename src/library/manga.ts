import { mangaKey, type ChapterSummary, type MangaDetails, type ProviderId } from '../core/types';
import { getProvider } from '../providers';
import { getCachedManga, putCachedManga } from '../storage/manga-cache';
import { settings } from './store';

export interface MangaWithChapters {
  details: MangaDetails;
  chapters: ChapterSummary[];
  /** True when the network failed and the data came from the offline cache. */
  offline: boolean;
  fetchedAt: number;
}

/**
 * Load a title and its chapters from the provider, keeping a copy so the
 * page still works offline. Falls back to the copy when the network fails.
 */
export async function loadManga(provider: ProviderId, id: string, signal?: AbortSignal): Promise<MangaWithChapters> {
  const key = mangaKey(provider, id);
  const languages = [...settings.languages];
  const cached = await getCachedManga(key);
  if (provider === 'local') {
    if (!cached) throw Object.assign(new Error('Not found'), { code: 'not_found' });
    return { details: cached.details, chapters: cached.chapters, offline: false, fetchedAt: cached.fetchedAt };
  }
  try {
    const source = getProvider(provider);
    const [details, chapters] = await Promise.all([source.getManga(id, signal), source.getChapters(id, { languages }, signal)]);
    const fetchedAt = Date.now();
    await putCachedManga({ key, details, chapters, languages, fetchedAt });
    return { details, chapters, offline: false, fetchedAt };
  } catch (error) {
    if (signal?.aborted || !cached) throw error;
    return { details: cached.details, chapters: cached.chapters, offline: true, fetchedAt: cached.fetchedAt };
  }
}

/** Group chapters by volume, keeping reading order. */
export function groupByVolume(chapters: ChapterSummary[]): Array<{ volume?: string; chapters: ChapterSummary[] }> {
  const groups: Array<{ volume?: string; chapters: ChapterSummary[] }> = [];
  for (const chapter of chapters) {
    const last = groups[groups.length - 1];
    if (last && last.volume === chapter.volume) last.chapters.push(chapter);
    else groups.push({ volume: chapter.volume, chapters: [chapter] });
  }
  return groups;
}

/**
 * The chapter that follows `current` in reading order, preferring the same
 * scanlation group when a chapter number has several releases.
 */
export function adjacentChapter(chapters: ChapterSummary[], current: ChapterSummary, step: 1 | -1): ChapterSummary | undefined {
  const index = chapters.findIndex(chapter => chapter.id === current.id);
  if (index < 0) return undefined;
  const sameNumber = (a: ChapterSummary, b: ChapterSummary) => a.number === b.number && a.volume === b.volume && a.number !== undefined;
  let cursor = index + step;
  while (chapters[cursor] && sameNumber(chapters[cursor], current)) cursor += step;
  const target = chapters[cursor];
  if (!target) return undefined;
  const candidates = chapters.filter(chapter => sameNumber(chapter, target) || chapter.id === target.id);
  const groupKey = (current.groups ?? []).join('|');
  return candidates.find(chapter => !chapter.externalUrl && (chapter.groups ?? []).join('|') === groupKey)
    ?? candidates.find(chapter => !chapter.externalUrl)
    ?? target;
}
