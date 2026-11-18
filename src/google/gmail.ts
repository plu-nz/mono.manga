/**
 * Sends an email with one attachment from the user's own Gmail account
 * (scope `gmail.send` only), e.g. an EPUB to a Send-to-Kindle address.
 *
 * The MIME message is assembled as a `Blob` of parts and the base64 body is
 * produced slice by slice, so a 25 MB EPUB never becomes one giant string.
 */
import { getAccessToken, invalidateAccessToken } from './auth';
import { GoogleError, googleErrorFromStatus } from './errors';

/**
 * `users.messages.send` media upload limit: `maxSize: "36700160"` (35 MiB)
 * in the Gmail API discovery document. Applies to the whole RFC 822 message,
 * after base64 encoding.
 */
export const GMAIL_MAX_MESSAGE_BYTES = 36_700_160;

/** Room left for headers, the text part, boundaries, and a safety margin. */
const MESSAGE_OVERHEAD_RESERVE = 64 * 1024;
const LINE_LENGTH = 76;
/** 57 raw bytes encode to exactly one 76-char base64 line. */
const BYTES_PER_LINE = (LINE_LENGTH / 4) * 3;
/** Blob slice size: a multiple of 57 (hence of 3), so slices encode independently. */
const SLICE_BYTES = BYTES_PER_LINE * 16 * 1024;
const CRLF = '\r\n';
/**
 * The JSON `messages.send` endpoint. Gmail's media-upload endpoint
 * (`/upload/gmail/...`) answers preflights but sends no CORS headers on its
 * actual responses, so browsers see every upload as a network error; this
 * endpoint returns CORS headers, so the message travels as base64url `raw`.
 */
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
/** Raw bytes per base64url chunk; a multiple of 3 so chunks concatenate cleanly. */
const RAW_CHUNK_BYTES = 3 * 256 * 1024;

export interface MimeAttachment {
  blob: Blob;
  fileName: string;
  mimeType: string;
}

export interface MimeMessageInput {
  to: string;
  subject: string;
  text: string;
  attachment: MimeAttachment;
  /** Optional; Gmail fills in the authenticated user. */
  from?: string;
}

export interface SendOptions {
  /** Upload progress in bytes of the encoded message. */
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** Allow a consent popup if the token is missing (only from a user gesture). Defaults to false. */
  interactive?: boolean;
}

export interface SentMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
}

// --- Encoding helpers -------------------------------------------------------------

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/** Splits base64 text into 76-char lines, each terminated by CRLF. */
function wrapBase64(base64: string): string {
  let out = '';
  for (let offset = 0; offset < base64.length; offset += LINE_LENGTH) {
    out += base64.slice(offset, offset + LINE_LENGTH) + CRLF;
  }
  return out;
}

/** Size of `bytes` raw bytes once base64-encoded and wrapped (CRLF after every line). */
export function base64WrappedLength(bytes: number): number {
  const chars = 4 * Math.ceil(bytes / 3);
  return chars + 2 * Math.ceil(chars / LINE_LENGTH);
}

function readSlice(blob: Blob): Promise<ArrayBuffer> {
  return typeof blob.arrayBuffer === 'function' ? blob.arrayBuffer() : new Response(blob).arrayBuffer();
}

/** Base64 of a Blob as wrapped string chunks, one per slice. */
async function base64Parts(blob: Blob): Promise<string[]> {
  const parts: string[] = [];
  for (let offset = 0; offset < blob.size; offset += SLICE_BYTES) {
    const bytes = new Uint8Array(await readSlice(blob.slice(offset, offset + SLICE_BYTES)));
    parts.push(wrapBase64(bytesToBase64(bytes)));
  }
  return parts;
}

function assertHeaderSafe(label: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new TypeError(`${label} must not contain line breaks`);
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * RFC 2047 `B` encoding for non-ASCII header text. Each encoded word stays
 * within 75 chars (≤ 45 UTF-8 bytes) and never splits a character; words are
 * folded onto continuation lines.
 */
export function encodeHeaderText(value: string): string {
  if (PRINTABLE_ASCII.test(value)) return value;
  const words: number[][] = [];
  let chunk: number[] = [];
  for (const char of value) {
    const bytes = encoder.encode(char);
    if (chunk.length + bytes.length > 45) {
      words.push(chunk);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(chunk);
  return words.map((bytes) => `=?UTF-8?B?${bytesToBase64(Uint8Array.from(bytes))}?=`).join(`${CRLF} `);
}

/** ASCII-only stand-in for clients that ignore RFC 2231 (keeps the extension). */
export function asciiFileName(fileName: string): string {
  const ascii = fileName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .trim();
  return ascii || 'attachment';
}

const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/** RFC 2231 percent-encoding of UTF-8 bytes (value part of `filename*`). */
export function rfc2231Encode(value: string): string {
  let out = '';
  for (const byte of encoder.encode(value)) {
    const char = String.fromCharCode(byte);
    out += byte < 0x80 && ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * `filename*` parameter(s). A single parameter when it fits a header line;
 * otherwise RFC 2231 continuations (`filename*0*`, `filename*1*`, …) cut
 * between percent-escapes.
 */
function extendedFileNameParams(fileName: string): string[] {
  const encoded = rfc2231Encode(fileName);
  if (encoded.length <= 900) return [`filename*=UTF-8''${encoded}`];
  const segments: string[] = [];
  let index = 0;
  while (index < encoded.length) {
    let end = Math.min(index + 60, encoded.length);
    const percent = encoded.lastIndexOf('%', end - 1);
    if (percent > end - 3 && percent >= index && end < encoded.length) end = percent;
    segments.push(encoded.slice(index, end));
    index = end;
  }
  return segments.map((segment, i) => (i === 0 ? `filename*0*=UTF-8''${segment}` : `filename*${i}*=${segment}`));
}

function attachmentHeaders(attachment: MimeAttachment): string {
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) ? attachment.mimeType : 'application/octet-stream';
  const fallback = asciiFileName(attachment.fileName);
  // Extended parameters go on folded continuation lines.
  const disposition = [`attachment; filename="${fallback}"`];
  if (!PRINTABLE_ASCII.test(attachment.fileName) || /["\\]/.test(attachment.fileName)) {
    disposition.push(...extendedFileNameParams(attachment.fileName));
  }
  return [
    `Content-Type: ${mimeType}; name="${fallback}"`,
    `Content-Disposition: ${disposition.join(`;${CRLF} `)}`,
    'Content-Transfer-Encoding: base64',
  ].join(CRLF);
}

function randomBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  // `_` and `=` never appear in a base64 body line, so the boundary cannot collide.
  return `=_manga_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Builds a `multipart/mixed` RFC 822 message with a text part and one base64 attachment. */
export async function buildMimeMessage(input: MimeMessageInput): Promise<Blob> {
  assertHeaderSafe('to', input.to);
  if (input.from !== undefined) assertHeaderSafe('from', input.from);
  assertHeaderSafe('subject', input.subject);
  assertHeaderSafe('fileName', input.attachment.fileName);

  const boundary = randomBoundary();
  const headers = [
    'MIME-Version: 1.0',
    ...(input.from ? [`From: ${input.from}`] : []),
    `To: ${input.to}`,
    `Subject: ${encodeHeaderText(input.subject)}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(bytesToBase64(encoder.encode(input.text))),
  ].join(CRLF);

  const parts: BlobPart[] = [
    headers.join(CRLF) + CRLF + CRLF,
    textPart,
    `--${boundary}${CRLF}${attachmentHeaders(input.attachment)}${CRLF}${CRLF}`,
    ...(await base64Parts(input.attachment.blob)),
    `--${boundary}--${CRLF}`,
  ];
  return new Blob(parts, { type: 'message/rfc822' });
}

/**
 * Largest raw attachment that still fits `GMAIL_MAX_MESSAGE_BYTES` after
 * base64 + CRLF line breaks, reserving 64 KiB for headers and the text part.
 */
export function maxAttachmentBytes(): number {
  const available = GMAIL_MAX_MESSAGE_BYTES - MESSAGE_OVERHEAD_RESERVE;
  return Math.floor(available / (LINE_LENGTH + 2)) * BYTES_PER_LINE;
}

// --- Sending ------------------------------------------------------------------------

function abortReason(signal?: AbortSignal): unknown {
  const reason = signal?.reason;
  return reason instanceof Error || (typeof DOMException !== 'undefined' && reason instanceof DOMException)
    ? reason
    : new DOMException('The send was aborted', 'AbortError');
}

/** `{"raw":"<base64url of the message>"}` built chunk by chunk as a Blob, never one giant string. */
export async function buildRawJsonBody(mime: Blob): Promise<Blob> {
  const parts: BlobPart[] = ['{"raw":"'];
  for (let offset = 0; offset < mime.size; offset += RAW_CHUNK_BYTES) {
    const bytes = new Uint8Array(await mime.slice(offset, offset + RAW_CHUNK_BYTES).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    parts.push(btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  }
  parts.push('"}');
  return new Blob(parts, { type: 'application/json' });
}

function postJson(token: string, body: Blob, options: SendOptions): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = (): void => xhr.abort();
    const cleanup = (): void => options.signal?.removeEventListener('abort', onAbort);
    xhr.open('POST', SEND_URL);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (event) => {
      options.onProgress?.(event.loaded, event.lengthComputable ? event.total : body.size);
    };
    xhr.onload = () => {
      cleanup();
      resolve({ status: xhr.status, text: xhr.responseText });
    };
    xhr.onerror = () => {
      cleanup();
      reject(new GoogleError('network', 'The request to Gmail failed'));
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      cleanup();
      reject(abortReason(options.signal));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(body);
  });
}

/**
 * Sends a ready RFC 822 message with `users.messages.send` (JSON `raw`),
 * reporting upload progress and retrying once with a fresh token on 401.
 * Abort with `signal` (rejects with an `AbortError`).
 */
export async function sendMimeMessage(mime: Blob, options: SendOptions = {}): Promise<SentMessage> {
  if (mime.size > GMAIL_MAX_MESSAGE_BYTES) {
    throw new GoogleError('too_large', `Message is ${mime.size} bytes; Gmail accepts up to ${GMAIL_MAX_MESSAGE_BYTES}`);
  }
  if (options.signal?.aborted) throw abortReason(options.signal);
  const body = await buildRawJsonBody(mime);
  const interactive = options.interactive ?? false;
  let token = await getAccessToken(['gmail'], { interactive });
  let response = await postJson(token, body, options);
  if (response.status === 401) {
    invalidateAccessToken(token);
    token = await getAccessToken(['gmail'], { interactive });
    response = await postJson(token, body, options);
  }
  if (response.status < 200 || response.status >= 300) throw googleErrorFromStatus(response.status, response.text, 'Gmail send');
  try {
    const sent = JSON.parse(response.text) as SentMessage;
    options.onProgress?.(body.size, body.size);
    return sent;
  } catch (error) {
    throw new GoogleError('api', 'Gmail returned an unreadable response', { cause: error });
  }
}

export interface SendFileInput extends SendOptions {
  to: string;
  subject: string;
  text: string;
  file: Blob;
  fileName: string;
  mimeType: string;
  from?: string;
}

/** Builds and sends a message with `file` attached; `too_large` is thrown before any work. */
export async function sendFileByEmail(input: SendFileInput): Promise<SentMessage> {
  if (input.file.size > maxAttachmentBytes()) {
    throw new GoogleError('too_large', `Attachment is ${input.file.size} bytes; the limit is ${maxAttachmentBytes()}`);
  }
  const mime = await buildMimeMessage({
    to: input.to,
    from: input.from,
    subject: input.subject,
    text: input.text,
    attachment: { blob: input.file, fileName: input.fileName, mimeType: input.mimeType },
  });
  return sendMimeMessage(mime, { onProgress: input.onProgress, signal: input.signal, interactive: input.interactive });
}
