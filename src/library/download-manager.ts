import { createStore, produce } from 'solid-js/store';
import { createSignal } from 'solid-js';
import { mangaKey, type ChapterSummary } from '../core/types';
import { chapterKey, requestPersistentStorage, type ChapterKey } from '../storage/db';
import { deleteDownload, downloadChapter, listDownloads } from '../storage/downloads';
import { remotePageRefs } from '../reader/pages';
import { deleteCachedManga, listCachedManga, putCachedManga } from '../storage/manga-cache';
import { library, removeFromLibrary, settings } from './store';

export interface DownloadState {
  status: 'queued' | 'downloading' | 'complete' | 'partial' | 'error';
  done: number;
  total: number;
  error?: unknown;
}

/** Offline chapter downloads, one chapter at a time, with reactive progress. */
const [states, setStates] = createStore<Record<ChapterKey, DownloadState>>({});
const [version, setVersion] = createSignal(0);
export { states as downloadStates, version as downloadsVersion };

const queue: Array<{ chapter: ChapterSummary; title: string }> = [];
let running = false;
let current: AbortController | undefined;

export async function loadDownloadStates(): Promise<void> {
  const records = await listDownloads();
  setStates(produce(draft => {
    for (const record of records) {
      draft[record.chapterKey] = { status: record.status, done: record.storedPages, total: record.pageCount };
    }
  }));
}

export function isDownloaded(chapter: ChapterSummary): boolean {
  return states[chapterKey(chapter)]?.status === 'complete';
}

export function queueDownloads(chapters: ChapterSummary[], mangaTitle: string): void {
  void requestPersistentStorage();
  for (const chapter of chapters) {
    const key = chapterKey(chapter);
    if (chapter.externalUrl || states[key]?.status === 'complete' || states[key]?.status === 'queued' || states[key]?.status === 'downloading') continue;
    setStates(key, { status: 'queued', done: states[key]?.done ?? 0, total: chapter.pages });
    queue.push({ chapter, title: mangaTitle });
  }
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const { chapter, title } = queue.shift()!;
      const key = chapterKey(chapter);
      if (states[key]?.status !== 'queued') continue;
      current = new AbortController();
      setStates(key, { status: 'downloading', done: 0, total: chapter.pages });
      try {
        const pages = await remotePageRefs(chapter, settings.dataSaver, current.signal);
        const record = await downloadChapter({
          mangaKey: mangaKey(chapter.provider, chapter.mangaId),
          mangaTitle: title,
          chapter,
          pages,
          signal: current.signal,
          onProgress: progress => setStates(key, { status: 'downloading', done: progress.done, total: progress.total }),
        });
        setStates(key, { status: record.status, done: record.storedPages, total: record.pageCount });
      } catch (error) {
        setStates(key, { status: current.signal.aborted ? 'partial' : 'error', done: states[key]?.done ?? 0, total: chapter.pages, error });
      }
      setVersion(value => value + 1);
    }
  } finally {
    running = false;
    current = undefined;
  }
}

export function cancelDownloads(): void {
  for (const item of queue.splice(0)) setStates(chapterKey(item.chapter), 'status', 'partial');
  current?.abort();
}

export async function removeDownload(key: ChapterKey): Promise<void> {
  await deleteDownload(key);
  if (key.startsWith('local:')) await forgetImportedChapter(key.slice('local:'.length));
  setStates(produce(draft => { delete draft[key]; }));
  setVersion(value => value + 1);
}

/** An imported chapter has no other copy: drop it from its title, and the title when it is empty. */
async function forgetImportedChapter(chapterId: string): Promise<void> {
  for (const cached of await listCachedManga()) {
    if (cached.details.provider !== 'local' || !cached.chapters.some(chapter => chapter.id === chapterId)) continue;
    const chapters = cached.chapters.filter(chapter => chapter.id !== chapterId);
    if (chapters.length) {
      const cover = cached.details.coverUrl?.endsWith(chapterId) ? `local-cover:${chapters[0].id}` : cached.details.coverUrl;
      await putCachedManga({ ...cached, chapters, details: { ...cached.details, coverUrl: cover } });
    } else {
      await deleteCachedManga(cached.key);
      if (library[cached.key]) await removeFromLibrary(cached.key);
    }
  }
}
