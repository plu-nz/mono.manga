/**
 * Extra chapter sources, restricted to an allowlist of Google accounts.
 *
 * - A verified Google access token is exchanged once for a signed session
 *   (HMAC, long-lived) that the app keeps on the device.
 * - Every relay request needs that session, and the email in it must still be
 *   on the allowlist, so removing an address revokes access.
 * - Page images are served through URLs signed by the Worker, because images
 *   load from <img> tags that cannot send an Authorization header.
 *
 * Kept free of Hono so the rules are easy to read and test.
 */

export const WEEBCENTRAL = 'https://weebcentral.com';
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const MAX_SEARCH_LENGTH = 100;

export interface Session {
  email: string;
  expiresAt: number;
}

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

async function hmac(secret: string, purpose: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(`${purpose}\n${value}`)));
}

/** Constant-time comparison of two signatures. */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export function parseAllowlist(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(/[\s,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean));
}

export async function signSession(secret: string, session: Session): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ e: session.email, x: session.expiresAt })));
  return `${payload}.${await hmac(secret, 'session', payload)}`;
}

/** The session in a token when its signature, expiry, and allowlist entry are all valid. */
export async function verifySession(secret: string, token: string, allowlist: Set<string>, now = Date.now()): Promise<Session | undefined> {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!sameSignature(signature, await hmac(secret, 'session', payload))) return undefined;
  try {
    const data = JSON.parse(fromBase64url(payload)) as { e?: unknown; x?: unknown };
    if (typeof data.e !== 'string' || typeof data.x !== 'number' || data.x <= now) return undefined;
    if (!allowlist.has(data.e.toLowerCase())) return undefined;
    return { email: data.e, expiresAt: data.x };
  } catch {
    return undefined;
  }
}

export function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}

export interface TokenInfo {
  email?: string;
  email_verified?: string | boolean;
  aud?: string;
  azp?: string;
}

/** Email of a Google access token issued to this app for a verified address. */
export function verifiedEmail(info: TokenInfo, clientId: string | undefined): string | undefined {
  if (clientId && info.aud !== clientId && info.azp !== clientId) return undefined;
  if (info.email_verified !== true && info.email_verified !== 'true') return undefined;
  return typeof info.email === 'string' ? info.email.toLowerCase() : undefined;
}

export function isSourceId(value: string): boolean {
  return ULID.test(value);
}

export function searchUpstreamUrl(query: string): string {
  const params = new URLSearchParams({
    author: '', text: query, sort: 'Best Match', order: 'Descending',
    official: 'Any', anime: 'Any', adult: 'Any', display_mode: 'Full Display',
  });
  return `${WEEBCENTRAL}/search/data?${params}`;
}

export function chapterListUpstreamUrl(seriesId: string): string {
  return `${WEEBCENTRAL}/series/${seriesId}/full-chapter-list`;
}

export function pagesUpstreamUrl(chapterId: string): string {
  return `${WEEBCENTRAL}/chapters/${chapterId}/images?is_prev=False&current_page=1&reading_style=long_strip`;
}

/** Absolute https image URLs of a chapter, in page order. */
export function parsePageImages(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc="(https:\/\/[^"]+)"[^>]*?\balt="Page \d+"/g)) {
    if (!urls.includes(match[1])) urls.push(match[1]);
  }
  return urls;
}

export async function signImageUrl(secret: string, url: string): Promise<string> {
  const encoded = base64url(encoder.encode(url));
  return `/api/weebcentral/image?u=${encoded}&s=${await hmac(secret, 'image', encoded)}`;
}

/** The upstream URL of a signed image link, or undefined when the signature does not match. */
export async function verifyImageUrl(secret: string, encoded: string | undefined, signature: string | undefined): Promise<string | undefined> {
  if (!encoded || !signature || encoded.length > 2048) return undefined;
  if (!sameSignature(signature, await hmac(secret, 'image', encoded))) return undefined;
  try {
    const url = fromBase64url(encoded);
    return url.startsWith('https://') ? url : undefined;
  } catch {
    return undefined;
  }
}
