import { createSignal } from 'solid-js';
import { getAccessToken } from '../../google/auth';
import { getKv, setKv } from '../../storage/db';

/**
 * Access to extra chapter sources. The Worker serves them to any signed-in
 * Google account: a Google access token is exchanged once for a signed
 * session, kept on this device and never synced.
 */

export interface ExtraSession {
  token: string;
  email: string;
  expiresAt: number;
}

const SESSION_KEY = 'extra.session';
const [session, setSession] = createSignal<ExtraSession>();
export { session as extraSession };

let loading: Promise<void> | undefined;

export function loadExtraSession(): Promise<void> {
  loading ??= getKv<ExtraSession>(SESSION_KEY).then(saved => {
    setSession(saved && saved.expiresAt > Date.now() ? saved : undefined);
  });
  return loading;
}

export function extraSourcesUnlocked(): boolean {
  const current = session();
  return Boolean(current && current.expiresAt > Date.now());
}

export class ExtraAccessError extends Error {
  constructor(readonly code: 'not_authorized' | 'not_configured' | 'network' | 'upstream', message: string) {
    super(message);
  }
}

/** Ask Google who the user is (popup when needed) and request a session for that account. */
export async function unlockExtraSources(): Promise<ExtraSession> {
  const accessToken = await getAccessToken(['identity'], { interactive: true });
  let response: Response;
  try {
    response = await fetch('/api/extra/session', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new ExtraAccessError('network', 'Session request failed');
  }
  if (response.status === 403 || response.status === 401) throw new ExtraAccessError('not_authorized', `Session refused (${response.status})`);
  if (response.status === 404) throw new ExtraAccessError('not_configured', 'Extra sources are not configured');
  if (!response.ok) throw new ExtraAccessError('upstream', `Session error ${response.status}`);
  const next = (await response.json()) as ExtraSession;
  await setKv(SESSION_KEY, next);
  setSession(next);
  return next;
}

export async function lockExtraSources(): Promise<void> {
  await setKv(SESSION_KEY, undefined);
  setSession(undefined);
}

/** Authorization header for relay requests, or undefined when locked. */
export async function extraAuthHeader(): Promise<Record<string, string> | undefined> {
  await loadExtraSession();
  return extraSourcesUnlocked() ? { Authorization: `Bearer ${session()!.token}` } : undefined;
}
