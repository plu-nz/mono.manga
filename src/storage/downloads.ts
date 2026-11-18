import type { ChapterSummary, MangaKey, PageRef } from '../core/types';
import { chapterKey, db, type ChapterKey, type DownloadRecord } from './db';

export async function getDownload(key: ChapterKey): Promise<DownloadRecord | undefined> {
  return (await db()).get('downloads', key);
}

export async function listDownloads(): Promise<DownloadRecord[]> {
  const all = await (await db()).getAll('downloads');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function listDownloadsForManga(mangaKey: MangaKey): Promise<DownloadRecord[]> {
  return (await db()).getAllFromIndex('downloads', 'byManga', mangaKey);
}

export async function getStoredPage(key: ChapterKey, index: number): Promise<Blob | undefined> {
  return (await (await db()).get('pages', [key, index]))?.blob;
}

export async function putStoredPage(key: ChapterKey, index: number, blob: Blob): Promise<void> {
  await (await db()).put('pages', { chapterKey: key, index, blob });
}

export async function putDownload(record: DownloadRecord): Promise<void> {
  await (await db()).put('downloads', record);
}

export async function deleteDownload(key: ChapterKey): Promise<void> {
  const database = await db();
  const tx = database.transaction(['downloads', 'pages'], 'readwrite');
  await tx.objectStore('downloads').delete(key);
  const pages = tx.objectStore('pages').index('byChapter');
  for (let cursor = await pages.openCursor(IDBKeyRange.only(key)); cursor; cursor = await cursor.continue()) {
    await cursor.delete();
  }
  await tx.done;
}

export async function deleteDownloadsForManga(mangaKey: MangaKey): Promise<void> {
  for (const record of await listDownloadsForManga(mangaKey)) await deleteDownload(record.chapterKey);
}

/** Fetch an image, trying the fallback URL on failure. */
export async function fetchPageBlob(page: PageRef, signal?: AbortSignal): Promise<Blob> {
  const urls = [page.url, page.fallbackUrl].filter((url): url is string => Boolean(url));
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith('image/') && blob.size === 0) throw new Error('Empty image');
      return blob;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Image unavailable');
}

export interface DownloadProgress {
  done: number;
  total: number;
}

/**
 * Store every page of a chapter for offline reading and conversion.
 * Resumes a partial download, keeping pages already stored.
 */
export async function downloadChapter(input: {
  mangaKey: MangaKey;
  mangaTitle: string;
  chapter: ChapterSummary;
  pages: PageRef[];
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (progress: DownloadProgress) => void;
}): Promise<DownloadRecord> {
  const key = chapterKey(input.chapter);
  const existing = await getDownload(key);
  const record: DownloadRecord = existing ?? {
    chapterKey: key,
    mangaKey: input.mangaKey,
    mangaTitle: input.mangaTitle,
    chapter: input.chapter,
    pageCount: input.pages.length,
    storedPages: 0,
    bytes: 0,
    status: 'partial',
    createdAt: Date.now(),
  };
  record.pageCount = input.pages.length;
  await putDownload(record);

  const missing: PageRef[] = [];
  for (const page of input.pages) if (!(await getStoredPage(key, page.index))) missing.push(page);
  let done = input.pages.length - missing.length;
  input.onProgress?.({ done, total: input.pages.length });

  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const page = missing[cursor++];
      const blob = await fetchPageBlob(page, input.signal);
      await putStoredPage(key, page.index, blob);
      record.bytes += blob.size;
      done += 1;
      input.onProgress?.({ done, total: input.pages.length });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(input.concurrency ?? 3, missing.length) }, worker));
  } finally {
    // Keep what was stored so a later attempt resumes instead of starting over.
    record.storedPages = done;
    record.status = done >= input.pages.length ? 'complete' : 'partial';
    await putDownload(record);
  }
  return record;
}

/** Store pages that are already in memory (local imports). */
export async function storeImportedChapter(input: {
  mangaKey: MangaKey;
  mangaTitle: string;
  chapter: ChapterSummary;
  pages: Blob[];
}): Promise<DownloadRecord> {
  const key = chapterKey(input.chapter);
  let bytes = 0;
  for (const [index, blob] of input.pages.entries()) {
    await putStoredPage(key, index, blob);
    bytes += blob.size;
  }
  const record: DownloadRecord = {
    chapterKey: key,
    mangaKey: input.mangaKey,
    mangaTitle: input.mangaTitle,
    chapter: input.chapter,
    pageCount: input.pages.length,
    storedPages: input.pages.length,
    bytes,
    status: 'complete',
    createdAt: Date.now(),
  };
  await putDownload(record);
  return record;
}
