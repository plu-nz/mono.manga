import type { ChapterSummary, MangaDetails } from '../core/types';
import { chapterNumber } from '../kindle/auto';
import { mangaKey } from '../core/types';
import { isChapterRead, progress, setChaptersRead } from '../library/store';
import { aniListAccount, getAniListEntry, loadAniList, saveAniListEntry } from './anilist';

/**
 * Keeps AniList in step with local read marks. AniList stores one number per
 * title ("chapters read"), so the app pushes the highest whole chapter read
 * and, when pulling, marks every chapter up to AniList's number as read unless
 * the user explicitly marked it unread here.
 */

/** AniList media id from the provider's external links (MangaDex lists it). */
export function aniListId(details: Pick<MangaDetails, 'links'>): number | undefined {
  for (const link of details.links ?? []) {
    const match = /^https:\/\/anilist\.co\/manga\/(\d+)/.exec(link.url);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** Highest whole chapter number marked read locally. */
export function highestReadNumber(details: MangaDetails, chapters: ChapterSummary[]): number {
  const key = mangaKey(details.provider, details.id);
  let highest = 0;
  for (const chapter of chapters) {
    const value = chapterNumber(chapter);
    if (value !== undefined && value > highest && isChapterRead(key, chapter.id)) highest = value;
  }
  return Math.floor(highest);
}

/** Last number known to be on AniList per media, to skip redundant requests. */
const remoteProgress = new Map<number, number>();

/** Raise AniList's progress to the highest chapter read here. Never lowers it. */
export async function pushToAniList(details: MangaDetails, chapters: ChapterSummary[]): Promise<boolean> {
  await loadAniList();
  const id = aniListId(details);
  if (!id || !aniListAccount()) return false;
  const local = highestReadNumber(details, chapters);
  if (local <= 0 || local <= (remoteProgress.get(id) ?? -1)) return false;
  const entry = await getAniListEntry(id);
  remoteProgress.set(id, entry?.progress ?? 0);
  if (entry && entry.progress >= local) return false;
  // Keep finished or rereading titles as they are; otherwise mark as reading.
  const status = entry?.status === 'COMPLETED' || entry?.status === 'REPEATING' ? entry.status : 'CURRENT';
  await saveAniListEntry(id, { progress: local, status });
  remoteProgress.set(id, local);
  return true;
}

/** Mark chapters up to AniList's progress as read here. Returns how many changed. */
export async function pullFromAniList(details: MangaDetails, chapters: ChapterSummary[]): Promise<number> {
  await loadAniList();
  const id = aniListId(details);
  if (!id || !aniListAccount()) return 0;
  const entry = await getAniListEntry(id);
  const remote = entry?.progress ?? 0;
  remoteProgress.set(id, remote);
  if (remote <= 0) return 0;
  const key = mangaKey(details.provider, details.id);
  const marks = progress[key] && !progress[key].deleted ? progress[key].chapters ?? {} : {};
  const ids = chapters
    .filter(chapter => {
      const value = chapterNumber(chapter);
      return value !== undefined && value <= remote && !marks[chapter.id] && !isChapterRead(key, chapter.id);
    })
    .map(chapter => chapter.id);
  if (ids.length) await setChaptersRead(key, ids, true);
  return ids.length;
}

/** Fire-and-forget wrappers for screens: tracker trouble never blocks reading. */
export function syncTitleWithTracker(details: MangaDetails, chapters: ChapterSummary[]): void {
  void pullFromAniList(details, chapters).then(() => pushToAniList(details, chapters)).catch(() => undefined);
}

export function reportReadToTracker(details: MangaDetails, chapters: ChapterSummary[]): void {
  void pushToAniList(details, chapters).catch(() => undefined);
}
