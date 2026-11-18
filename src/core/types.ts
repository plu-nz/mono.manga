/**
 * Domain types shared by every module. This file has no runtime dependencies
 * and is the contract between providers, the library, the reader, the
 * converter, and synchronization.
 */

export type ProviderId = 'mangadex' | 'local';

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
  /** Chapters the user finished, by chapter id. */
  read?: string[];
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
