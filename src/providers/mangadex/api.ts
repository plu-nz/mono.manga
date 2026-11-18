/**
 * The subset of the MangaDex JSON API (https://api.mangadex.org/docs/) this
 * provider reads, plus a small client that maps HTTP failures to
 * `ProviderError` codes.
 */
import { ProviderError } from '../errors';

export type LocalizedString = Record<string, string>;

export interface Relationship<A = unknown> {
  id: string;
  type: string;
  attributes?: A;
}

export interface TagAttributes {
  name: LocalizedString;
  group: string;
}

export interface MangaAttributes {
  title: LocalizedString;
  altTitles?: LocalizedString[];
  description?: LocalizedString;
  originalLanguage?: string;
  status?: string | null;
  year?: number | null;
  contentRating?: string;
  tags?: Array<{ id: string; type: 'tag'; attributes: TagAttributes }>;
  availableTranslatedLanguages?: Array<string | null>;
  links?: Record<string, string> | null;
  latestUploadedChapter?: string | null;
}

export interface MangaEntity {
  id: string;
  type: 'manga';
  attributes: MangaAttributes;
  relationships: Relationship<{ name?: string; fileName?: string }>[];
}

export interface ChapterAttributes {
  volume: string | null;
  chapter: string | null;
  title: string | null;
  translatedLanguage: string;
  externalUrl: string | null;
  publishAt?: string;
  readableAt?: string;
  createdAt?: string;
  pages: number;
  isUnavailable?: boolean;
}

export interface ChapterEntity {
  id: string;
  type: 'chapter';
  attributes: ChapterAttributes;
  relationships: Relationship<{ name?: string }>[];
}

export interface Collection<T> {
  result: 'ok';
  data: T[];
  limit: number;
  offset: number;
  total: number;
}

export interface Entity<T> {
  result: 'ok';
  data: T;
}

export interface AtHomeServer {
  result: 'ok';
  baseUrl: string;
  chapter: { hash: string; data: string[]; dataSaver: string[] };
}

export type Params = Array<[string, string | number | undefined]>;

export function buildQuery(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of params) if (value !== undefined && value !== '') search.append(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof DOMException && error.name === 'AbortError');
}

function retryAfter(headers: Headers): number | undefined {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export interface ApiClient {
  get<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T>;
}

export function createApiClient(baseUrl: string, fetcher: typeof fetch): ApiClient {
  return {
    async get<T>(path: string, params: Params = [], signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/${path}${buildQuery(params)}`, { signal, headers: { accept: 'application/json' } });
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        throw new ProviderError('network', 'MangaDex request failed', { cause: error });
      }
      if (response.status === 429) {
        throw new ProviderError('rate_limited', 'MangaDex rate limit reached', { status: 429, retryAfter: retryAfter(response.headers) });
      }
      if (response.status === 404) throw new ProviderError('not_found', `MangaDex ${path} not found`, { status: 404 });
      if (!response.ok) throw new ProviderError('upstream', `MangaDex responded ${response.status}`, { status: response.status });
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        throw new ProviderError('upstream', 'MangaDex returned invalid JSON', { status: response.status, cause: error });
      }
      if (!body || typeof body !== 'object' || (body as { result?: string }).result !== 'ok') {
        throw new ProviderError('upstream', 'MangaDex returned an error result', { status: response.status });
      }
      return body as T;
    },
  };
}
