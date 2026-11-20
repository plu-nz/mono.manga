import { createSignal, createStore, reconcile } from 'solid-js';
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
  type SourceLink,
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

/*
 * Plain copies of the same records for this module's own reads. Store writes
 * show on the next flush, and a write is followed here by decisions on what
 * was just written (often after an await), so those decisions read these.
 */
let libraryNow: Record<MangaKey, LibraryEntry> = {};
let progressNow: Record<MangaKey, ReadingProgress> = {};
let settingsNow: AppSettings = { ...DEFAULT_SETTINGS };

function storeEntry(entry: LibraryEntry): void {
  libraryNow[entry.key] = entry;
  setLibrary(draft => {
    if (draft[entry.key]) reconcile(entry)(draft[entry.key]);
    else draft[entry.key] = entry;
  });
}

function storeProgress(entry: ReadingProgress): void {
  progressNow[entry.key] = entry;
  setProgress(draft => {
    if (draft[entry.key]) reconcile(entry)(draft[entry.key]);
    else draft[entry.key] = entry;
  });
}

function storeSettings(next: AppSettings): void {
  settingsNow = next;
  setSettingsStore(reconcile(next));
}

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
  libraryNow = Object.fromEntries(entries.map(entry => [entry.key, entry]));
  progressNow = Object.fromEntries(progressEntries.map(entry => [entry.key, entry]));
  setLibrary(reconcile({ ...libraryNow }));
  setProgress(reconcile({ ...progressNow }));
  storeSettings({ ...DEFAULT_SETTINGS, ...stored });
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

function liveEntry(key: MangaKey): LibraryEntry | undefined {
  const entry = libraryNow[key];
  return entry && !entry.deleted ? entry : undefined;
}

async function putEntry(input: LibraryEntry): Promise<void> {
  const entry = plain(input);
  await (await db()).put('library', entry);
  storeEntry(entry);
  changed();
}

export async function addToLibrary(details: MangaDetails): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  const now = Date.now();
  const previous = libraryNow[key];
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
  const entry = libraryNow[key];
  if (!entry) return;
  await putEntry({ ...entry, favorite: false, deleted: true, updatedAt: Date.now() });
}

export async function setFavorite(details: MangaDetails, favorite: boolean): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  if (!liveEntry(key)) await addToLibrary(details);
  await putEntry({ ...libraryNow[key], favorite, updatedAt: Date.now() });
}

export async function toggleFavorite(details: MangaDetails): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  await setFavorite(details, !liveEntry(key)?.favorite);
}

/** Per-title reading mode; keeps a (non-favorite) entry so the choice survives and syncs. */
export async function setTitleMode(details: MangaDetails, mode: ReadingMode | undefined): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  if (!liveEntry(key)) await addToLibrary(details);
  await putEntry({ ...libraryNow[key], mode, updatedAt: Date.now() });
}

/** Link (or unlink) an extra source that fills chapters missing from the title's provider. */
export async function setSourceLink(details: MangaDetails, link: SourceLink | undefined): Promise<void> {
  const key = mangaKey(details.provider, details.id);
  if (!liveEntry(key)) await addToLibrary(details);
  const current = libraryNow[key];
  const sources = { ...current.sources };
  if (link) {
    sources.weebcentral = { id: link.id, title: link.title };
    delete sources.declined;
  } else {
    // Stopping by hand also keeps automatic matching away from this title.
    delete sources.weebcentral;
    sources.declined = true;
  }
  await putEntry({ ...current, sources: Object.keys(sources).length ? sources : undefined, updatedAt: Date.now() });
}

export async function saveProgress(input: {
  key: MangaKey;
  chapter: ChapterSummary;
  chapterLabel: string;
  page: number;
  pageCount: number;
}): Promise<void> {
  const previous = progressNow[input.key];
  const chapters = previous && !previous.deleted ? chapterMarks(previous) : {};
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
  storeProgress(plain(next));
  changed();
}

export async function setChaptersRead(key: MangaKey, chapterIds: string[], value: boolean): Promise<void> {
  const previous = progressNow[key];
  const live = previous && !previous.deleted ? previous : undefined;
  const chapters = chapterMarks(live);
  const now = Date.now();
  for (const id of chapterIds) chapters[id] = { read: value, at: now };
  const next: ReadingProgress = live
    ? { ...live, chapters, updatedAt: now }
    : { key, chapterId: chapterIds[0] ?? '', page: 0, pageCount: 0, chapters, updatedAt: now };
  next.read = readChapterIds(next);
  await (await db()).put('progress', plain(next));
  storeProgress(plain(next));
  changed();
}

const MAX_SENT_IDS = 2000;

/** Record chapters delivered to the Kindle (or marked as such) for a title in the library. */
export async function markSentToKindle(details: MangaDetails, chapters: ChapterSummary[]): Promise<void> {
  if (!chapters.length) return;
  const key = mangaKey(details.provider, details.id);
  if (!liveEntry(key)) await addToLibrary(details);
  const entry = libraryNow[key];
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

/**
 * Forget that chapters reached the Kindle. The baseline for "Send new
 * chapters" falls back to the highest chapter still marked, looked up in
 * the title's current `known` chapter list.
 */
export async function unmarkSentToKindle(key: MangaKey, chapters: ChapterSummary[], known: ChapterSummary[]): Promise<void> {
  const entry = libraryNow[key];
  const previous = entry?.kindle;
  if (!previous || entry.deleted) return;
  const removed = new Set(chapters.map(chapter => chapter.id));
  const sentIds = previous.sentIds.filter(id => !removed.has(id));
  const remaining = known.filter(chapter => sentIds.includes(chapter.id) && Number.isFinite(Number(chapter.number)));
  const highest = remaining.length ? Math.max(...remaining.map(chapter => Number(chapter.number))) : undefined;
  const latest = [...remaining].reverse().find(chapter => Number(chapter.number) === highest);
  // Sent ids from another source may not be in the list; keep the old baseline rather than guess.
  const keepPrevious = highest === undefined && sentIds.length > 0;
  const kindle = sentIds.length
    ? {
        ...previous,
        sentIds,
        lastNumber: keepPrevious ? previous.lastNumber : highest,
        lastGroups: keepPrevious ? previous.lastGroups : latest?.groups,
      }
    : undefined;
  await putEntry({ ...entry, kindle, updatedAt: Date.now() });
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
  const next: AppSettings = plain({ ...settingsNow, ...patch, updatedAt: Date.now() });
  await writeSettings(next);
  storeSettings(next);
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
    storeSettings(next);
    return;
  }
  const tx = database.transaction(collection, 'readwrite');
  for (const record of Object.values(records)) await tx.store.put(record as LibraryEntry & ReadingProgress);
  await tx.done;
  if (collection === 'library') for (const record of Object.values(records) as LibraryEntry[]) storeEntry(record);
  else for (const record of Object.values(records) as ReadingProgress[]) storeProgress(record);
}
