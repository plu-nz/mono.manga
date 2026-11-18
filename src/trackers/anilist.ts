import { createSignal } from 'solid-js';
import { getKv, setKv } from '../storage/db';

/**
 * AniList account link. Uses the implicit grant: AniList redirects back to
 * /auth/anilist with a one-year access token in the URL fragment, so no server
 * is involved. The token stays on this device (IndexedDB) and is never synced.
 */

export const ANILIST_REDIRECT_PATH = '/auth/anilist';
const GRAPHQL_URL = 'https://graphql.anilist.co';
const AUTHORIZE_URL = 'https://anilist.co/api/v2/oauth/authorize';
const ACCOUNT_KEY = 'tracker.anilist';
const PENDING_KEY = 'plunz-manga.anilist-pending';
/** A callback is accepted only shortly after this browser started connecting. */
const PENDING_FOR = 10 * 60 * 1000;

export interface AniListAccount {
  token: string;
  expiresAt: number;
  userId: number;
  userName: string;
}

export type AniListStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING';

export interface AniListEntry {
  progress: number;
  status?: AniListStatus;
}

export class AniListError extends Error {
  constructor(readonly code: 'not_configured' | 'network' | 'rate_limited' | 'tracker_auth' | 'upstream', message: string) {
    super(message);
  }
}

const [account, setAccount] = createSignal<AniListAccount>();
export { account as aniListAccount };

let loading: Promise<void> | undefined;

export function loadAniList(): Promise<void> {
  loading ??= getKv<AniListAccount>(ACCOUNT_KEY).then(saved => {
    setAccount(saved && saved.expiresAt > Date.now() ? saved : undefined);
  });
  return loading;
}

function clientId(): string | undefined {
  const value = import.meta.env.VITE_ANILIST_CLIENT_ID as string | undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isAniListConfigured(): boolean {
  return clientId() !== undefined;
}

/** Leave the app for AniList's consent page; it returns to ANILIST_REDIRECT_PATH. */
export function connectAniList(): void {
  const id = clientId();
  if (!id) throw new AniListError('not_configured', 'VITE_ANILIST_CLIENT_ID is not set');
  try { localStorage.setItem(PENDING_KEY, String(Date.now())); } catch { /* private mode: the callback is refused */ }
  location.assign(`${AUTHORIZE_URL}?${new URLSearchParams({ client_id: id, response_type: 'token' })}`);
}

/** Finish the redirect: read the token from the fragment and look up the viewer. */
export async function completeAniListConnect(hash: string): Promise<AniListAccount> {
  let started = 0;
  try {
    started = Number(localStorage.getItem(PENDING_KEY));
    localStorage.removeItem(PENDING_KEY);
  } catch { /* handled below */ }
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('access_token');
  if (!token || !started || Date.now() - started > PENDING_FOR) {
    throw new AniListError('tracker_auth', params.get('error') ?? 'Unexpected AniList callback');
  }
  const expiresIn = Number(params.get('expires_in')) || 365 * 24 * 3600;
  const data = await graphql<{ Viewer: { id: number; name: string } }>('query { Viewer { id name } }', {}, token);
  const linked: AniListAccount = { token, expiresAt: Date.now() + expiresIn * 1000, userId: data.Viewer.id, userName: data.Viewer.name };
  await setKv(ACCOUNT_KEY, linked);
  setAccount(linked);
  return linked;
}

export async function disconnectAniList(): Promise<void> {
  await setKv(ACCOUNT_KEY, undefined);
  setAccount(undefined);
}

async function graphql<T>(query: string, variables: Record<string, unknown>, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new AniListError('network', 'AniList is unreachable');
  }
  if (response.status === 429) throw new AniListError('rate_limited', 'AniList rate limit');
  if (response.status === 401 || response.status === 403) {
    if (token && token === account()?.token) await disconnectAniList();
    throw new AniListError('tracker_auth', `AniList rejected the token (${response.status})`);
  }
  const body = (await response.json().catch(() => undefined)) as { data?: T; errors?: Array<{ message: string; status?: number }> } | undefined;
  if (!body?.data) {
    // A missing list entry comes back as a 404 error with null data.
    if (body?.errors?.some(error => error.status === 404)) return { Media: null } as T;
    throw new AniListError('upstream', body?.errors?.[0]?.message ?? `AniList error ${response.status}`);
  }
  return body.data;
}

function requireToken(): string {
  const linked = account();
  if (!linked) throw new AniListError('tracker_auth', 'AniList is not connected');
  return linked.token;
}

/** The viewer's list entry for a manga, if any. */
export async function getAniListEntry(mediaId: number): Promise<AniListEntry | undefined> {
  const data = await graphql<{ Media: { mediaListEntry: AniListEntry | null } | null }>(
    'query ($id: Int) { Media(id: $id, type: MANGA) { mediaListEntry { progress status } } }',
    { id: mediaId },
    requireToken(),
  );
  return data.Media?.mediaListEntry ?? undefined;
}

export async function saveAniListEntry(mediaId: number, entry: AniListEntry): Promise<void> {
  await graphql(
    'mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) { SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) { id } }',
    { mediaId, progress: entry.progress, status: entry.status },
    requireToken(),
  );
}
