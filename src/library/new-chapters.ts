import { createSignal, createStore } from 'solid-js';
import type { ChapterSummary, MangaKey } from '../core/types';
import { pickNewChapters, baselineNumber } from '../kindle/auto';
import { loadManga } from './manga';
import { library, libraryEntries, loadLibrary, progress, settings } from './store';

/**
 * New chapters of each favorite, refreshed when the Library opens. Counts are
 * derived reactively from the fetched chapter lists, so reading a chapter or
 * sending it to the Kindle updates them without another network request.
 */

interface ChapterList {
  chapters: ChapterSummary[];
  checkedAt: number;
}

const [lists, setLists] = createStore<Record<MangaKey, ChapterList>>({});
const [checking, setChecking] = createSignal(false);
export { checking as checkingNewChapters };
// The same flag for the guard: a signal write shows on the next flush, so two
// calls in one tick would both see it unset.
let running = false;

/** Lists younger than this are reused when the Library opens again. */
const FRESH_FOR = 10 * 60 * 1000;
const CONCURRENCY = 2;

/** Chapters after the last one sent or read; empty when the title has no starting point yet. */
export function newChaptersFor(key: MangaKey): ChapterSummary[] {
  const list = lists[key];
  const entry = library[key];
  if (!list || !entry) return [];
  const current = progress[key];
  if (baselineNumber(list.chapters, entry.kindle, current) === undefined) return [];
  return pickNewChapters({ chapters: list.chapters, languages: [...settings.languages], kindle: entry.kindle, progress: current });
}

export function totalNewChapters(): number {
  return libraryEntries().filter(entry => entry.favorite).reduce((sum, entry) => sum + newChaptersFor(entry.key).length, 0);
}

export async function refreshNewChapters(options: { force?: boolean } = {}): Promise<void> {
  if (running) return;
  // The Favorites screen can mount before the library finishes loading on a cold start.
  await loadLibrary();
  if (running) return;
  const now = Date.now();
  const due = libraryEntries().filter(entry => entry.favorite && (options.force || !lists[entry.key] || now - lists[entry.key].checkedAt > FRESH_FOR));
  if (!due.length) return;
  running = true;
  setChecking(true);
  try {
    let cursor = 0;
    const worker = async () => {
      while (cursor < due.length) {
        const entry = due[cursor++];
        try {
          // Falls back to the offline copy when the network is unavailable.
          const { chapters } = await loadManga(entry.provider, entry.mangaId);
          setLists(draft => { draft[entry.key] = { chapters, checkedAt: Date.now() }; });
        } catch {
          // Keep the previous list; the title simply shows no count.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  } finally {
    running = false;
    setChecking(false);
  }
}
