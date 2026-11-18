import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AppSettings, ChapterSummary, LibraryEntry, MangaDetails, MangaKey, ReadingProgress } from '../core/types';

/** `${provider}:${chapterId}` */
export type ChapterKey = string;

export interface CachedManga {
  key: MangaKey;
  details: MangaDetails;
  chapters: ChapterSummary[];
  /** Languages the chapter list was fetched for. */
  languages: string[];
  fetchedAt: number;
}

export interface DownloadRecord {
  chapterKey: ChapterKey;
  mangaKey: MangaKey;
  mangaTitle: string;
  chapter: ChapterSummary;
  pageCount: number;
  storedPages: number;
  bytes: number;
  status: 'complete' | 'partial';
  createdAt: number;
}

export interface StoredPage {
  chapterKey: ChapterKey;
  index: number;
  blob: Blob;
}

export interface UpdateItem {
  chapter: ChapterSummary;
  mangaKey: MangaKey;
  mangaTitle: string;
  foundAt: number;
  seen: boolean;
}

interface MangaDB extends DBSchema {
  library: { key: MangaKey; value: LibraryEntry };
  progress: { key: MangaKey; value: ReadingProgress };
  kv: { key: string; value: unknown };
  manga: { key: MangaKey; value: CachedManga };
  downloads: { key: ChapterKey; value: DownloadRecord; indexes: { byManga: MangaKey } };
  pages: { key: [ChapterKey, number]; value: StoredPage; indexes: { byChapter: ChapterKey } };
  updates: { key: string; value: UpdateItem; indexes: { byFoundAt: number } };
}

export type MangaDatabase = IDBPDatabase<MangaDB>;

const DB_NAME = 'plunz-manga';
let dbPromise: Promise<MangaDatabase> | undefined;

export function db(): Promise<MangaDatabase> {
  dbPromise ??= openDB<MangaDB>(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore('library', { keyPath: 'key' });
      database.createObjectStore('progress', { keyPath: 'key' });
      database.createObjectStore('kv');
      database.createObjectStore('manga', { keyPath: 'key' });
      database.createObjectStore('downloads', { keyPath: 'chapterKey' }).createIndex('byManga', 'mangaKey');
      database.createObjectStore('pages', { keyPath: ['chapterKey', 'index'] }).createIndex('byChapter', 'chapterKey');
      database.createObjectStore('updates', { keyPath: 'chapter.id' }).createIndex('byFoundAt', 'foundAt');
    },
  });
  return dbPromise;
}

/** Test helper: forget the cached connection (fake-indexeddb resets between tests). */
export function resetDbForTests(): void {
  dbPromise = undefined;
}

export function chapterKey(chapter: Pick<ChapterSummary, 'provider' | 'id'>): ChapterKey {
  return `${chapter.provider}:${chapter.id}`;
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}

export async function readSettings(): Promise<AppSettings | undefined> {
  return getKv<AppSettings>('settings');
}

export async function writeSettings(settings: AppSettings): Promise<void> {
  await setKv('settings', settings);
}

/** Ask the browser not to evict offline chapters under storage pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | undefined> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return undefined;
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return undefined;
  }
}
