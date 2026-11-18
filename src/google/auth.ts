/**
 * Google sign-in for a backend-less PWA, using the Google Identity Services
 * (GIS) token model. The browser obtains short-lived access tokens directly
 * from Google; nothing is stored on a server.
 *
 * Persistence trade-off: `localStorage` keeps only `{ connected, email,
 * grantedScopes }` so the UI knows the user opted in. The access token lives
 * in memory and in `sessionStorage` (per tab, cleared when the tab closes)
 * with its expiry, so a reload inside the same tab does not need a popup.
 * Any script running on the origin could read it during its ≈1 h lifetime;
 * that is the accepted cost of having no backend.
 */
import { GoogleError, googleFetch, isGoogleError } from './errors';

export { GoogleError } from './errors';

export const SCOPES = {
  identity: ['openid', 'email'],
  drive: ['https://www.googleapis.com/auth/drive.appdata'],
  gmail: ['https://www.googleapis.com/auth/gmail.send'],
} as const;

export type ScopeSet = keyof typeof SCOPES;

export interface GoogleState {
  configured: boolean;
  connected: boolean;
  email?: string;
  /** Scope sets the user has granted (identity included once connected). */
  scopes: ScopeSet[];
}

const SCOPE_SETS = Object.keys(SCOPES) as ScopeSet[];
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const ACCOUNT_KEY = 'manga.google.account';
const TOKEN_KEY = 'manga.google.token';
/** Treat tokens as expired this long before Google says they are. */
const EXPIRY_MARGIN_MS = 60_000;
/** A silent (`prompt: 'none'`) request that never calls back counts as needing interaction. */
const SILENT_TIMEOUT_MS = 20_000;
/** Safety net in case GIS never reports a closed popup. */
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000;
const REVOKE_TIMEOUT_MS = 5_000;

/** Google reports some short scopes by their long form in token responses. */
const SCOPE_ALIASES: Record<string, string> = {
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
};

// --- Minimal GIS typings (only what this module uses) -----------------------

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface TokenClientConfig {
  client_id: string;
  scope: string;
  include_granted_scopes?: boolean;
  prompt?: '' | 'none' | 'consent' | 'select_account';
  login_hint?: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type: string; message?: string }) => void;
}

interface TokenClient {
  requestAccessToken(overrides?: Partial<Pick<TokenClientConfig, 'prompt' | 'scope' | 'login_hint' | 'include_granted_scopes'>>): void;
}

export interface GoogleOAuth2 {
  initTokenClient(config: TokenClientConfig): TokenClient;
  hasGrantedAllScopes(response: TokenResponse, firstScope: string, ...rest: string[]): boolean;
  revoke(accessToken: string, done?: () => void): void;
}

// --- State --------------------------------------------------------------------

interface StoredAccount {
  connected: true;
  email?: string;
  grantedScopes: string[];
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms when Google considers the token expired. */
  expiresAt: number;
  scopes: string[];
}

let account: StoredAccount | null | undefined;
let token: CachedToken | null | undefined;
let snapshot: GoogleState | null = null;
let gisLoading: Promise<GoogleOAuth2> | null = null;
let storageListenerAttached = false;
const listeners = new Set<(state: GoogleState) => void>();

function clientId(): string | undefined {
  const value = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isGoogleConfigured(): boolean {
  return clientId() !== undefined;
}

function storage(kind: 'local' | 'session'): Storage | undefined {
  try {
    return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function readJson<T>(kind: 'local' | 'session', key: string): T | null {
  try {
    const raw = storage(kind)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(kind: 'local' | 'session', key: string, value: unknown): void {
  try {
    if (value === null) storage(kind)?.removeItem(key);
    else storage(kind)?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private mode, quota); memory still works.
  }
}

function parseAccount(value: unknown): StoredAccount | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredAccount>;
  if (candidate.connected !== true || !Array.isArray(candidate.grantedScopes)) return null;
  return {
    connected: true,
    email: typeof candidate.email === 'string' ? candidate.email : undefined,
    grantedScopes: candidate.grantedScopes.filter((scope): scope is string => typeof scope === 'string'),
  };
}

function readAccount(): StoredAccount | null {
  if (account === undefined) account = parseAccount(readJson('local', ACCOUNT_KEY));
  return account;
}

function readToken(): CachedToken | null {
  if (token === undefined) {
    const stored = readJson<CachedToken>('session', TOKEN_KEY);
    token =
      stored && typeof stored.accessToken === 'string' && typeof stored.expiresAt === 'number' && Array.isArray(stored.scopes)
        ? stored
        : null;
  }
  if (token && token.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) setToken(null);
  return token;
}

function setAccount(next: StoredAccount | null): void {
  account = next;
  writeJson('local', ACCOUNT_KEY, next);
  notify();
}

function setToken(next: CachedToken | null): void {
  token = next;
  writeJson('session', TOKEN_KEY, next);
}

function notify(): void {
  snapshot = null;
  const state = getGoogleState();
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch (error) {
      console.error('Google state listener failed', error);
    }
  }
}

function attachStorageListener(): void {
  if (storageListenerAttached || typeof window === 'undefined') return;
  storageListenerAttached = true;
  // Another tab connected or disconnected: reload the persisted account.
  window.addEventListener('storage', (event) => {
    if (event.key !== ACCOUNT_KEY && event.key !== null) return;
    account = undefined;
    if (!readAccount()) setToken(null);
    notify();
  });
}

// --- Scope helpers ------------------------------------------------------------

function normalizeScope(scope: string): string {
  return SCOPE_ALIASES[scope] ?? scope;
}

function parseScopes(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

function covers(granted: readonly string[], needed: readonly string[]): boolean {
  const set = new Set(granted.map(normalizeScope));
  return needed.every((scope) => set.has(normalizeScope(scope)));
}

/** Identity scopes are always part of a request: the account must be identifiable. */
function scopesFor(sets: readonly ScopeSet[]): string[] {
  const all = new Set<string>(SCOPES.identity);
  for (const set of sets) for (const scope of SCOPES[set]) all.add(scope);
  return [...all];
}

function grantedSets(scopes: readonly string[]): ScopeSet[] {
  return SCOPE_SETS.filter((set) => covers(scopes, SCOPES[set]));
}

// --- Public state -------------------------------------------------------------

export function getGoogleState(): GoogleState {
  if (snapshot) return snapshot;
  const configured = isGoogleConfigured();
  const current = readAccount();
  snapshot = current
    ? { configured, connected: true, email: current.email, scopes: grantedSets(current.grantedScopes) }
    : { configured, connected: false, scopes: [] };
  return snapshot;
}

/** Calls `listener` on every state change; returns an unsubscribe function. */
export function subscribeGoogleState(listener: (state: GoogleState) => void): () => void {
  attachStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- GIS loading ----------------------------------------------------------------

function currentOAuth2(): GoogleOAuth2 | undefined {
  return (globalThis as { google?: { accounts?: { oauth2?: GoogleOAuth2 } } }).google?.accounts?.oauth2;
}

function loadOAuth2(): Promise<GoogleOAuth2> {
  const ready = currentOAuth2();
  if (ready) return Promise.resolve(ready);
  if (!gisLoading) {
    gisLoading = new Promise<GoogleOAuth2>((resolve, reject) => {
      if (typeof document === 'undefined') {
        reject(new GoogleError('network', 'Google Identity Services needs a document'));
        return;
      }
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => {
        const loaded = currentOAuth2();
        if (loaded) resolve(loaded);
        else reject(new GoogleError('network', 'Google Identity Services loaded without google.accounts.oauth2'));
      };
      script.onerror = () => {
        script.remove();
        reject(new GoogleError('network', 'Could not load Google Identity Services'));
      };
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      gisLoading = null;
      throw error;
    });
  }
  return gisLoading;
}

/**
 * Loads the GIS client ahead of time. Call it when a screen that may connect
 * renders: popups only open reliably when `requestAccessToken` runs
 * synchronously inside the click handler, which requires GIS to be loaded.
 */
export function preloadGoogle(): Promise<void> {
  if (!isGoogleConfigured()) return Promise.resolve();
  return loadOAuth2().then(
    () => undefined,
    () => undefined,
  );
}

// --- Token requests ---------------------------------------------------------------

interface RequestMode {
  prompt: '' | 'none' | 'select_account';
  silent: boolean;
}

function mapResponseError(error: string, description: string | undefined, silent: boolean): GoogleError {
  const message = `Google authorization failed: ${error}${description ? ` (${description})` : ''}`;
  if (silent) return new GoogleError('interaction_required', message);
  if (error === 'access_denied') return new GoogleError('access_denied', message);
  if (['interaction_required', 'login_required', 'consent_required', 'account_selection_required'].includes(error)) {
    return new GoogleError('interaction_required', message);
  }
  return new GoogleError('api', message);
}

function mapPopupError(type: string, silent: boolean): GoogleError {
  const message = `Google authorization popup error: ${type}`;
  if (silent) return new GoogleError('interaction_required', message);
  if (type === 'popup_failed_to_open') return new GoogleError('popup_blocked', message);
  if (type === 'popup_closed') return new GoogleError('popup_closed', message);
  return new GoogleError('api', message);
}

function runTokenRequest(oauth2: GoogleOAuth2, id: string, scopes: string[], mode: RequestMode): Promise<CachedToken> {
  return new Promise<CachedToken>((resolve, reject) => {
    let settled = false;
    const finish = (result: CachedToken | GoogleError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof GoogleError) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new GoogleError(mode.silent ? 'interaction_required' : 'popup_closed', 'Google authorization timed out')),
      mode.silent ? SILENT_TIMEOUT_MS : INTERACTIVE_TIMEOUT_MS,
    );
    try {
      const loginHint = readAccount()?.email;
      const client = oauth2.initTokenClient({
        client_id: id,
        scope: scopes.join(' '),
        include_granted_scopes: true,
        prompt: mode.prompt,
        ...(loginHint ? { login_hint: loginHint } : {}),
        callback: (response) => {
          if (response.error) {
            finish(mapResponseError(response.error, response.error_description, mode.silent));
            return;
          }
          if (!response.access_token) {
            finish(new GoogleError(mode.silent ? 'interaction_required' : 'api', 'Google returned no access token'));
            return;
          }
          let granted = parseScopes(response.scope);
          if (granted.length === 0) {
            granted = scopes.filter((scope) => {
              try {
                return oauth2.hasGrantedAllScopes(response, scope);
              } catch {
                return false;
              }
            });
          }
          const expiresIn = Number(response.expires_in) > 0 ? Number(response.expires_in) : 3600;
          finish({ accessToken: response.access_token, expiresAt: Date.now() + expiresIn * 1000, scopes: granted });
        },
        error_callback: (error) => finish(mapPopupError(error?.type ?? 'unknown', mode.silent)),
      });
      client.requestAccessToken();
    } catch (error) {
      finish(new GoogleError(mode.silent ? 'interaction_required' : 'api', 'Google Identity Services failed', { cause: error }));
    }
  });
}

/**
 * When GIS is already loaded the popup opens synchronously, preserving the
 * user gesture. Otherwise it loads first (popup may be blocked: preload).
 */
function requestToken(scopes: string[], mode: RequestMode): Promise<CachedToken> {
  const id = clientId();
  if (!id) return Promise.reject(new GoogleError('not_configured', 'VITE_GOOGLE_CLIENT_ID is not set'));
  const ready = currentOAuth2();
  if (ready) return runTokenRequest(ready, id, scopes, mode);
  return loadOAuth2().then(
    (oauth2) => runTokenRequest(oauth2, id, scopes, mode),
    (error: unknown) => {
      throw mode.silent ? new GoogleError('interaction_required', 'Google Identity Services unavailable', { cause: error }) : error;
    },
  );
}

async function fetchEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await googleFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { email?: unknown };
    return typeof body.email === 'string' ? body.email : undefined;
  } catch {
    return undefined;
  }
}

/** Stores a freshly granted token and the scopes Google reports as granted. */
function acceptToken(next: CachedToken, needed: string[], silent: boolean): string {
  setToken(next);
  const current = readAccount();
  if (current) {
    setAccount({ ...current, grantedScopes: next.scopes });
  } else {
    setAccount({ connected: true, grantedScopes: next.scopes });
    void fetchEmail(next.accessToken).then((email) => {
      const latest = readAccount();
      if (email && latest && !latest.email) setAccount({ ...latest, email });
    });
  }
  if (!covers(next.scopes, needed)) {
    throw new GoogleError(
      silent ? 'interaction_required' : 'access_denied',
      `Google did not grant: ${needed.filter((scope) => !covers(next.scopes, [scope])).join(', ')}`,
    );
  }
  return next.accessToken;
}

/**
 * Interactive sign-in. Call directly from a click handler (no `await` before
 * it). Requests identity plus `sets`, then reads the account email.
 * Resolves with the new state; rejects with `access_denied` if the user
 * unticked a requested permission (the account still counts as connected).
 */
export function connect(sets: ScopeSet[] = []): Promise<GoogleState> {
  const needed = scopesFor(sets);
  const mode: RequestMode = { prompt: readAccount() ? '' : 'select_account', silent: false };
  return requestToken(needed, mode).then(async (next) => {
    setToken(next);
    const email = await fetchEmail(next.accessToken);
    setAccount({ connected: true, email: email ?? readAccount()?.email, grantedScopes: next.scopes });
    if (!covers(next.scopes, needed)) {
      throw new GoogleError('access_denied', 'Some requested Google permissions were not granted');
    }
    return getGoogleState();
  });
}

/**
 * Returns a usable access token covering `sets`.
 * - A cached token valid for ≥ 60 s more whose scopes cover the request is reused.
 * - `interactive: true` opens the GIS popup (call from a user gesture).
 * - `interactive: false` tries a silent `prompt: 'none'` request only if the
 *   user connected before and already granted these scopes; any failure is
 *   `GoogleError('interaction_required')` so the UI can offer "Reconnect".
 */
export function getAccessToken(sets: ScopeSet[], { interactive }: { interactive: boolean }): Promise<string> {
  if (!isGoogleConfigured()) return Promise.reject(new GoogleError('not_configured', 'VITE_GOOGLE_CLIENT_ID is not set'));
  const needed = scopesFor(sets);
  const cached = readToken();
  if (cached && covers(cached.scopes, needed)) return Promise.resolve(cached.accessToken);

  const current = readAccount();
  if (!interactive) {
    if (!current) return Promise.reject(new GoogleError('interaction_required', 'Not connected to Google'));
    if (!covers(current.grantedScopes, needed)) {
      return Promise.reject(new GoogleError('interaction_required', 'Additional Google permissions are required'));
    }
    return requestToken(needed, { prompt: 'none', silent: true }).then((next) => acceptToken(next, needed, true));
  }
  return requestToken(needed, { prompt: '', silent: false }).then((next) => acceptToken(next, needed, false));
}

/** Drops the cached token (e.g. after a 401) so the next request fetches a new one. */
export function invalidateAccessToken(accessToken?: string): void {
  const cached = readToken();
  if (cached && (accessToken === undefined || cached.accessToken === accessToken)) setToken(null);
}

/**
 * Revokes the current grant (best effort: only possible while a token is
 * cached) and forgets the account on this device. Without a cached token the
 * user can still remove access at https://myaccount.google.com/permissions.
 */
export async function disconnect(): Promise<void> {
  const cached = readToken();
  setToken(null);
  setAccount(null);
  if (!cached) return;
  try {
    const oauth2 = currentOAuth2() ?? (await loadOAuth2());
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, REVOKE_TIMEOUT_MS);
      oauth2.revoke(cached.accessToken, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    // Local state is already cleared; revocation is best effort.
  }
}

/**
 * `fetch` with a bearer token for `sets`. Retries once with a fresh token on
 * 401. Returns the response as-is otherwise (callers use `ensureOk`). The
 * request body must be replayable (string, Blob, FormData…), not a stream.
 */
export async function authorizedFetch(
  sets: ScopeSet[],
  input: string | URL,
  init: RequestInit = {},
  options: { interactive: boolean } = { interactive: false },
): Promise<Response> {
  const send = (accessToken: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return googleFetch(input, { ...init, headers });
  };
  const first = await getAccessToken(sets, options);
  const response = await send(first);
  if (response.status !== 401) return response;
  invalidateAccessToken(first);
  let second: string;
  try {
    second = await getAccessToken(sets, options);
  } catch (error) {
    if (isGoogleError(error)) throw error;
    throw new GoogleError('interaction_required', 'Google rejected the access token', { cause: error });
  }
  return send(second);
}
