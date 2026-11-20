import { createSignal, createStore, reconcile } from 'solid-js';
import { mangaKey, type ChapterSummary } from '../core/types';
import { chapterKey, requestPersistentStorage, type ChapterKey } from '../storage/db';
import { deleteDownload, downloadChapter, listDownloads } from '../storage/downloads';
import { remotePageRefs } from '../reader/pages';
import { deleteCachedManga, listCachedManga, putCachedManga } from '../storage/manga-cache';
import { removeFromLibrary, settings } from './store';

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

// The same states for the queue's own decisions: a store write shows on the
// next flush, and the queue reads a state right after setting it.
const statesNow: Record<ChapterKey, DownloadState> = {};

function setState(key: ChapterKey, state: DownloadState | undefined): void {
  if (state) statesNow[key] = state;
  else delete statesNow[key];
  setStates(draft => {
    if (!state) delete draft[key];
    else if (draft[key]) reconcile(state)(draft[key]);
    else draft[key] = state;
  });
}

const queue: Array<{ chapter: ChapterSummary; title: string }> = [];
let running = false;
let current: AbortController | undefined;

export async function loadDownloadStates(): Promise<void> {
  const records = await listDownloads();
  for (const record of records) {
    setState(record.chapterKey, { status: record.status, done: record.storedPages, total: record.pageCount });
  }
}

export function isDownloaded(chapter: ChapterSummary): boolean {
  return states[chapterKey(chapter)]?.status === 'complete';
}

export function queueDownloads(chapters: ChapterSummary[], mangaTitle: string): void {
  void requestPersistentStorage();
  for (const chapter of chapters) {
    const key = chapterKey(chapter);
    const status = statesNow[key]?.status;
    if (chapter.externalUrl || status === 'complete' || status === 'queued' || status === 'downloading') continue;
    setState(key, { status: 'queued', done: statesNow[key]?.done ?? 0, total: chapter.pages });
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
      if (statesNow[key]?.status !== 'queued') continue;
      current = new AbortController();
      setState(key, { status: 'downloading', done: 0, total: chapter.pages });
      try {
        const pages = await remotePageRefs(chapter, settings.dataSaver, current.signal);
        const record = await downloadChapter({
          mangaKey: mangaKey(chapter.provider, chapter.mangaId),
          mangaTitle: title,
          chapter,
          pages,
          signal: current.signal,
          onProgress: progress => setState(key, { status: 'downloading', done: progress.done, total: progress.total }),
        });
        setState(key, { status: record.status, done: record.storedPages, total: record.pageCount });
      } catch (error) {
        setState(key, { status: current.signal.aborted ? 'partial' : 'error', done: statesNow[key]?.done ?? 0, total: chapter.pages, error });
      }
      setVersion(value => value + 1);
    }
  } finally {
    running = false;
    current = undefined;
  }
}

export function cancelDownloads(): void {
  for (const item of queue.splice(0)) {
    const key = chapterKey(item.chapter);
    const state = statesNow[key];
    if (state) setState(key, { ...state, status: 'partial' });
  }
  current?.abort();
}

export async function removeDownload(key: ChapterKey): Promise<void> {
  await deleteDownload(key);
  if (key.startsWith('local:')) await forgetImportedChapter(key.slice('local:'.length));
  setState(key, undefined);
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
      await removeFromLibrary(cached.key);
    }
  }
}
