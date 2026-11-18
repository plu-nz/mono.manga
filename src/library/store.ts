import { createStore, reconcile, unwrap } from 'solid-js/store';
import { createSignal } from 'solid-js';
import {
  chapterMarks,
  DEFAULT_SETTINGS,
  readChapterIds,
  mangaKey,
  type AppSettings,
  type ChapterSummary,
  type LibraryEntry,
  type MangaDetails,
  type MangaKey,
  type ReadingMode,
  type ReadingProgress,
  type SyncRecord,
} from '../core/types';
import { db, readSettings, writeSettings } from '../storage/db';

/**
 * Reactive view of the local library, progress, and settings. IndexedDB is
 * the source of truth; every change bumps `updatedAt` so synchronization can
 * merge it with other devices.
 */

const [library, setLibrary] = createStore<Record<MangaKey, LibraryEntry>>({});
const [progress, setProgress] = createStore<Record<MangaKey, ReadingProgress>>({});
const [settings, setSettingsStore] = createStore<AppSettings>({ ...DEFAULT_SETTINGS });
const [ready, setReady] = createSignal(false);

export { library, progress, settings, ready };

type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/** Called after every local write (used to schedule a sync). */
export function onLocalChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

let loading: Promise<void> | undefined;

export function loadLibrary(): Promise<void> {
  loading ??= readAll();
  return loading;
}

async function readAll(): Promise<void> {
  const database = await db();
  const [entries, progressEntries, stored] = await Promise.all([
    database.getAll('library'),
    database.getAll('progress'),
    readSettings(),
  ]);
  setLibrary(reconcile(Object.fromEntries(entries.map(entry => [entry.key, entry]))));
  setProgress(reconcile(Object.fromEntries(progressEntries.map(entry => [entry.key, entry]))));
  setSettingsStore(reconcile({ ...DEFAULT_SETTINGS, ...stored }));
  setReady(true);
}

export function libraryEntries(): LibraryEntry[] {
  return Object.values(library)
    .filter(entry => !entry.deleted)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function isInLibrary(key: MangaKey): boolean {
  const entry = library[key];
  return Boolean(entry && !entry.deleted);
}

/** Store values are proxies, which IndexedDB cannot clone; persist a plain copy. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function putEntry(input: LibraryEntry): Promise<void> {
  const entry = plain(input);
  await (await db()).put('library', entry);
  setLibrary(entry.key, reconcile(entry));
  changed();
}

export async function addToLibrary(details: MangaDetails): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  const now = Date.now();
  const previous = library[key];
  await putEntry({
    key,
    provider: details.provider,
    mangaId: details.id,
    title: details.title,
    coverUrl: details.coverUrl,
    originalLanguage: details.originalLanguage,
    favorite: previous && !previous.deleted ? previous.favorite : false,
    mode: previous?.mode,
    kindle: previous?.kindle,
    addedAt: previous && !previous.deleted ? previous.addedAt : now,
    updatedAt: now,
  });
}

export async function removeFromLibrary(key: MangaKey): Promise<void> {
  const entry = library[key];
  if (!entry) return;
  await putEntry({ ...entry, favorite: false, deleted: true, updatedAt: Date.now() });
}

export async function setFavorite(details: MangaDetails, favorite: boolean): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  if (!isInLibrary(key)) await addToLibrary(details);
  await putEntry({ ...library[key], favorite, updatedAt: Date.now() });
}

export async function toggleFavorite(details: MangaDetails): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  await setFavorite(details, !(isInLibrary(key) && library[key].favorite));
}

/** Per-title reading mode; keeps a (non-favorite) entry so the choice survives and syncs. */
export async function setTitleMode(details: MangaDetails, mode: ReadingMode | undefined): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  if (!isInLibrary(key)) await addToLibrary(details);
  await putEntry({ ...library[key], mode, updatedAt: Date.now() });
}

export async function saveProgress(input: {
  key: MangaKey;
  chapter: ChapterSummary;
  chapterLabel: string;
  page: number;
  pageCount: number;
}): Promise<void> {
  const previous = progress[input.key];
  const chapters = previous && !previous.deleted ? chapterMarks(unwrap(previous)) : {};
  const now = Date.now();
  // Reaching the last page counts as finishing the chapter.
  if (input.pageCount > 0 && input.page >= input.pageCount - 1 && !chapters[input.chapter.id]?.read) {
    chapters[input.chapter.id] = { read: true, at: now };
  }
  const next: ReadingProgress = {
    key: input.key,
    chapterId: input.chapter.id,
    chapterLabel: input.chapterLabel,
    page: input.page,
    pageCount: input.pageCount,
    chapters,
    updatedAt: now,
  };
  next.read = readChapterIds(next);
  await (await db()).put('progress', plain(next));
  setProgress(input.key, reconcile(next));
  changed();
}

export async function setChaptersRead(key: MangaKey, chapterIds: string[], value: boolean): Promise<void> {
  const previous = progress[key];
  const live = previous && !previous.deleted ? unwrap(previous) : undefined;
  const chapters = chapterMarks(live);
  const now = Date.now();
  for (const id of chapterIds) chapters[id] = { read: value, at: now };
  const next: ReadingProgress = live
    ? { ...live, chapters, updatedAt: now }
    : { key, chapterId: chapterIds[0] ?? '', page: 0, pageCount: 0, chapters, updatedAt: now };
  next.read = readChapterIds(next);
  await (await db()).put('progress', plain(next));
  setProgress(key, reconcile(next));
  changed();
}

const MAX_SENT_IDS = 2000;

/** Record chapters delivered to the Kindle (or marked as such) for a title in the library. */
export async function markSentToKindle(details: MangaDetails, chapters: ChapterSummary[]): Promise<void> {
  if (!chapters.length) return;
  const key = mangaKey(details.provider, details.id);
  if (!isInLibrary(key)) await addToLibrary(details);
  const entry = library[key];
  const previous = entry.kindle;
  const sent = [...(previous?.sentIds ?? []).filter(id => !chapters.some(chapter => chapter.id === id)), ...chapters.map(chapter => chapter.id)];
  const numbers = chapters.map(chapter => Number(chapter.number)).filter(Number.isFinite);
  const highest = numbers.length ? Math.max(...numbers) : undefined;
  const lastNumber = highest === undefined ? previous?.lastNumber : Math.max(highest, previous?.lastNumber ?? Number.NEGATIVE_INFINITY);
  const latest = [...chapters].reverse().find(chapter => Number(chapter.number) === highest) ?? chapters[chapters.length - 1];
  await putEntry({
    ...entry,
    kindle: { sentIds: sent.slice(-MAX_SENT_IDS), lastNumber, lastGroups: latest.groups ?? previous?.lastGroups, lastSentAt: Date.now() },
    updatedAt: Date.now(),
  });
}

export function isSentToKindle(key: MangaKey, chapterId: string): boolean {
  return Boolean(library[key]?.kindle?.sentIds.includes(chapterId));
}

export function isChapterRead(key: MangaKey, chapterId: string): boolean {
  const entry = progress[key];
  if (!entry || entry.deleted) return false;
  const mark = entry.chapters?.[chapterId];
  return mark ? mark.read : Boolean(entry.read?.includes(chapterId));
}

export async function updateSettings(patch: Partial<Omit<AppSettings, 'updatedAt'>>): Promise<void> {
  // Merge into the stored settings, never into defaults shown before loading finished.
  await loadLibrary();
  // Store values are proxies, which IndexedDB cannot clone; persist a plain copy.
  const next: AppSettings = plain({ ...unwrap(settings), ...patch, updatedAt: Date.now() });
  await writeSettings(next);
  setSettingsStore(reconcile(next));
  changed();
}

/** Resolve the reading mode: per-title override, then the global default, then the provider's suggestion. */
export function effectiveMode(key: MangaKey, suggested: ReadingMode): ReadingMode {
  const override = library[key]?.mode;
  if (override) return override;
  return settings.defaultMode === 'auto' ? suggested : settings.defaultMode;
}

/* ---------- Synchronization bridge ---------- */

export type SyncCollection = 'library' | 'progress' | 'settings';

export async function readCollection(collection: SyncCollection): Promise<Record<string, SyncRecord>> {
  const database = await db();
  if (collection === 'settings') {
    const stored = await readSettings();
    return stored ? { settings: stored } : {};
  }
  const rows = await database.getAll(collection);
  // Imported files exist only on this device, so their entries stay local.
  return Object.fromEntries(rows.filter(row => !row.key.startsWith('local:')).map(row => [row.key, row]));
}

/** Apply records that came from another device without triggering another sync. */
export async function applyCollection(collection: SyncCollection, records: Record<string, SyncRecord>): Promise<void> {
  const database = await db();
  if (collection === 'settings') {
    const incoming = records.settings as AppSettings | undefined;
    if (!incoming) return;
    const next = { ...DEFAULT_SETTINGS, ...incoming };
    await writeSettings(next);
    setSettingsStore(reconcile(next));
    return;
  }
  const tx = database.transaction(collection, 'readwrite');
  for (const record of Object.values(records)) await tx.store.put(record as LibraryEntry & ReadingProgress);
  await tx.done;
  if (collection === 'library') for (const record of Object.values(records) as LibraryEntry[]) setLibrary(record.key, reconcile(record));
  else for (const record of Object.values(records) as ReadingProgress[]) setProgress(record.key, reconcile(record));
}
