/**
 * Domain types shared by every module. This file has no runtime dependencies
 * and is the contract between providers, the library, the reader, the
 * converter, and synchronization.
 */

export type ProviderId = 'mangadex' | 'local' | 'weebcentral';

/** How pages advance. `vertical` is continuous top-to-bottom scrolling. */
export type ReadingMode = 'ltr' | 'rtl' | 'vertical';

/** `${provider}:${id}` — stable identity of a title across devices. */
export type MangaKey = string;

export function mangaKey(provider: ProviderId, id: string): MangaKey {
  return `${provider}:${id}`;
}

export function parseMangaKey(key: MangaKey): { provider: ProviderId; id: string } {
  const index = key.indexOf(':');
  return { provider: key.slice(0, index) as ProviderId, id: key.slice(index + 1) };
}

export interface MangaSummary {
  provider: ProviderId;
  id: string;
  title: string;
  /** Directly loadable image URL (CORS-enabled for MangaDex covers). */
  coverUrl?: string;
  description?: string;
  authors?: string[];
  status?: string;
  year?: number;
  /** ISO 639-1 (or provider tag such as `ja`, `ko`, `zh`). */
  originalLanguage?: string;
  contentRating?: string;
  tags?: string[];
}

export interface MangaDetails extends MangaSummary {
  altTitles?: string[];
  /** Suggested reading mode: Japanese manga `rtl`, webtoons `vertical`, otherwise `ltr`. */
  defaultMode: ReadingMode;
  /** Translated languages with at least one chapter, when the provider knows. */
  availableLanguages?: string[];
  links?: Array<{ label: string; url: string }>;
}

export interface ChapterSummary {
  provider: ProviderId;
  mangaId: string;
  id: string;
  /** Chapter number as text ("12", "12.5"); absent for oneshots. */
  number?: string;
  volume?: string;
  title?: string;
  language: string;
  pages: number;
  /** ISO date. */
  publishedAt?: string;
  /** Scanlation group names, shown for attribution. */
  groups?: string[];
  /** Hosted elsewhere (official publisher); cannot be read or converted here. */
  externalUrl?: string;
  /**
   * Provider that serves the pages when it differs from `provider`: a chapter
   * filled in from an extra source keeps the title's provider and id.
   */
  source?: ProviderId;
}

export interface PageRef {
  index: number;
  /** Absolute URL loadable with fetch() from the browser (CORS-enabled). */
  url: string;
  /** Alternative URL (e.g. lower quality) to try when `url` fails. */
  fallbackUrl?: string;
}

export interface SearchQuery {
  text: string;
  /** Translated languages the user can read; providers filter by them when possible. */
  languages?: string[];
  offset?: number;
  limit?: number;
  /** Content ratings to include; providers default to safe + suggestive. */
  contentRating?: string[];
}

export interface SearchResult {
  items: MangaSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface ProviderAttribution {
  text: string;
  url: string;
}

export interface MangaProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly attribution?: ProviderAttribution;
  readonly capabilities: { search: boolean; updates: boolean };
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult>;
  getManga(id: string, signal?: AbortSignal): Promise<MangaDetails>;
  /** All readable chapters in reading order (ascending volume/chapter). */
  getChapters(mangaId: string, options: { languages: string[] }, signal?: AbortSignal): Promise<ChapterSummary[]>;
  getPages(chapterId: string, options: { dataSaver: boolean }, signal?: AbortSignal): Promise<PageRef[]>;
  /** Chapters published after `since` (ISO) for many titles at once. */
  getUpdates?(mangaIds: string[], options: { languages: string[]; since: string }, signal?: AbortSignal): Promise<ChapterSummary[]>;
}

/** Every synchronized record carries a modification time and an optional tombstone. */
export interface SyncRecord {
  /** Milliseconds since epoch of the last local change. */
  updatedAt: number;
  /** Tombstone: the record was removed; kept so removal propagates. */
  deleted?: boolean;
}

export interface LibraryEntry extends SyncRecord {
  key: MangaKey;
  provider: ProviderId;
  mangaId: string;
  title: string;
  coverUrl?: string;
  originalLanguage?: string;
  favorite: boolean;
  /** Per-title override of the reading mode. */
  mode?: ReadingMode;
  addedAt: number;
  /** What was already delivered to the user's Kindle, so only new chapters are sent next time. */
  kindle?: KindleSendState;
  /** Extra sources linked to fill chapters the title's provider lacks. */
  sources?: {
    weebcentral?: SourceLink;
    /** The user stopped filling this title; never link it automatically again. */
    declined?: boolean;
  };
}

export interface SourceLink {
  id: string;
  title: string;
}

export interface KindleSendState {
  /** Chapter ids sent (most recent last, capped). */
  sentIds: string[];
  /** Highest chapter number sent, the baseline for "new chapters". */
  lastNumber?: number;
  /** Scanlation groups of the last sent chapter, preferred for the next ones. */
  lastGroups?: string[];
  lastSentAt?: number;
}

export interface ReadingProgress extends SyncRecord {
  key: MangaKey;
  chapterId: string;
  chapterLabel?: string;
  /** Zero-based page index. */
  page: number;
  pageCount: number;
  /**
   * Read state per chapter id with the time it last changed, so devices merge
   * chapter by chapter (a later "unread" beats an earlier "read").
   */
  chapters?: Record<string, ChapterMark>;
  /** Legacy list of finished chapter ids, still written for older app versions. */
  read?: string[];
}

export interface ChapterMark {
  read: boolean;
  /** Milliseconds since epoch of the last change. */
  at: number;
}

/** Read marks of a progress record, treating legacy `read` ids as read at `updatedAt`. */
export function chapterMarks(progress: Pick<ReadingProgress, 'chapters' | 'read' | 'updatedAt'> | undefined): Record<string, ChapterMark> {
  const marks: Record<string, ChapterMark> = {};
  for (const id of progress?.read ?? []) marks[id] = { read: true, at: progress!.updatedAt };
  for (const [id, mark] of Object.entries(progress?.chapters ?? {})) marks[id] = mark;
  return marks;
}

/** Chapter ids currently marked as read. */
export function readChapterIds(progress: Pick<ReadingProgress, 'chapters' | 'read' | 'updatedAt'> | undefined): string[] {
  return Object.entries(chapterMarks(progress)).filter(([, mark]) => mark.read).map(([id]) => id);
}

/**
 * Merge two devices' progress for one title: the reading position follows the
 * newer record; read marks merge per chapter, newest change winning (ties: read).
 */
export function mergeProgress(a: ReadingProgress, b: ReadingProgress): ReadingProgress {
  const newer = a.updatedAt >= b.updatedAt ? a : b;
  const marksA = chapterMarks(a);
  const marksB = chapterMarks(b);
  const chapters: Record<string, ChapterMark> = {};
  for (const id of new Set([...Object.keys(marksA), ...Object.keys(marksB)])) {
    const x = marksA[id];
    const y = marksB[id];
    chapters[id] = !x ? y : !y ? x : x.at !== y.at ? (x.at > y.at ? x : y) : { read: x.read || y.read, at: x.at };
  }
  const merged: ReadingProgress = { ...newer, chapters, updatedAt: Math.max(a.updatedAt, b.updatedAt) };
  merged.read = readChapterIds(merged);
  return merged;
}

export type KindleModelId = string;

export interface AppSettings extends SyncRecord {
  /** Chapter languages, in preference order. */
  languages: string[];
  defaultMode: ReadingMode | 'auto';
  dataSaver: boolean;
  kindleEmail?: string;
  kindleModel?: KindleModelId;
  /** Include content rated erotica/pornographic in search. Off by default. */
  showMature: boolean;
  /** List chapters newest first on title pages. */
  newestFirst?: boolean;
  /** Link titles to an extra source automatically when the names match. On unless false. */
  autoFill?: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  languages: ['en'],
  defaultMode: 'auto',
  dataSaver: false,
  showMature: false,
  updatedAt: 0,
};

/** Human label such as "Vol. 2 Ch. 12.5 — Title". */
export function chapterLabel(chapter: Pick<ChapterSummary, 'number' | 'volume' | 'title'>): string {
  const parts: string[] = [];
  if (chapter.volume) parts.push(`Vol. ${chapter.volume}`);
  if (chapter.number) parts.push(`Ch. ${chapter.number}`);
  const head = parts.join(' ') || 'Oneshot';
  return chapter.title ? `${head} — ${chapter.title}` : head;
}
