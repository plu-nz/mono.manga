import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getAccessToken: vi.fn(), invalidateAccessToken: vi.fn() }));

import { getAccessToken, invalidateAccessToken } from './auth';
import {
  GMAIL_MAX_MESSAGE_BYTES,
  asciiFileName,
  base64WrappedLength,
  buildMimeMessage,
  buildRawJsonBody,
  encodeHeaderText,
  maxAttachmentBytes,
  rfc2231Encode,
  sendFileByEmail,
  sendMimeMessage,
} from './gmail';

const mockedToken = vi.mocked(getAccessToken);
const mockedInvalidate = vi.mocked(invalidateAccessToken);

/** Decode the base64url `raw` field of a JSON send body back into the RFC 822 message. */
async function rawMessage(body: Blob): Promise<Blob> {
  const { raw } = JSON.parse(await body.text()) as { raw: string };
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
  return new Blob([Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))]);
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 65_536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65_536, length)));
  return bytes;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\r\n/g, ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeEncodedWords(value: string): string {
  const bytes = [...value.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].flatMap((match) => [...decodeBase64(match[1])]);
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

interface ParsedMessage {
  headers: string;
  boundary: string;
  parts: Array<{ headers: string; body: string }>;
  raw: string;
}

async function parse(blob: Blob): Promise<ParsedMessage> {
  const raw = await blob.text();
  const [headers] = raw.split('\r\n\r\n', 1);
  const boundary = /boundary="([^"]+)"/.exec(headers)![1];
  const sections = raw.split(`--${boundary}`);
  expect(sections.at(-1)).toBe('--\r\n');
  const parts = sections.slice(1, -1).map((section) => {
    const body = section.replace(/^\r\n/, '');
    const index = body.indexOf('\r\n\r\n');
    return { headers: body.slice(0, index), body: body.slice(index + 4) };
  });
  return { headers, boundary, parts, raw };
}

describe('buildMimeMessage', () => {
  it('builds a multipart/mixed message with exact base64 attachment bytes', async () => {
    // Larger than one internal slice and not a multiple of 3.
    const bytes = randomBytes(2_000_003);
    const blob = await buildMimeMessage({
      to: 'reader@kindle.com',
      subject: 'Chapter 1',
      text: 'Sent from Manga',
      attachment: { blob: new Blob([bytes]), fileName: 'chapter-1.epub', mimeType: 'application/epub+zip' },
    });
    expect(blob.type).toBe('message/rfc822');
    const message = await parse(blob);

    expect(message.headers).toContain('MIME-Version: 1.0');
    expect(message.headers).toContain('To: reader@kindle.com');
    expect(message.headers).toContain('Subject: Chapter 1');
    expect(message.headers).not.toContain('From:');
    expect(message.headers).toMatch(/Content-Type: multipart\/mixed; boundary="=_manga_[0-9a-f]{24}"/);

    expect(message.parts).toHaveLength(2);
    const [text, attachment] = message.parts;
    expect(text.headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(new TextDecoder().decode(decodeBase64(text.body))).toBe('Sent from Manga');

    expect(attachment.headers).toContain('Content-Type: application/epub+zip; name="chapter-1.epub"');
    expect(attachment.headers).toContain('Content-Disposition: attachment; filename="chapter-1.epub"');
    expect(attachment.headers).not.toContain('filename*');
    expect(attachment.headers).toContain('Content-Transfer-Encoding: base64');
    expect(decodeBase64(attachment.body)).toEqual(bytes);
    expect(attachment.body.length).toBe(base64WrappedLength(bytes.length));

    const bodyLines = attachment.body.split('\r\n');
    expect(bodyLines.at(-1)).toBe('');
    expect(bodyLines.slice(0, -2).every((line) => line.length === 76)).toBe(true);
    expect(bodyLines.at(-2)!.length).toBeLessThanOrEqual(76);
    // Every line in the message is CRLF-terminated and within limits.
    expect(message.raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(message.raw.split('\r\n').every((line) => line.length <= 998)).toBe(true);
  });

  it('handles empty attachments and includes From when given', async () => {
    const message = await parse(
      await buildMimeMessage({
        from: 'me@example.com',
        to: 'x@kindle.com',
        subject: 's',
        text: '',
        attachment: { blob: new Blob([]), fileName: 'a.epub', mimeType: 'application/epub+zip' },
      }),
    );
    expect(message.headers).toContain('From: me@example.com');
    expect(message.parts[1].body).toBe('');
  });

  it('encodes non-ASCII subjects (RFC 2047) and filenames (RFC 2231)', async () => {
    const subject = 'ワンピース 第1話 — Café';
    const fileName = 'ワンピース 第1話 Café.epub';
    const message = await parse(
      await buildMimeMessage({
        to: 'x@kindle.com',
        subject,
        text: 'Olá, ação!',
        attachment: { blob: new Blob([new Uint8Array([1, 2, 3])]), fileName, mimeType: 'application/epub+zip' },
      }),
    );
    const subjectHeader = /Subject: ([\s\S]*?)\r\nContent-Type/.exec(message.headers)![1];
    for (const word of subjectHeader.split('\r\n ')) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeEncodedWords(subjectHeader)).toBe(subject);

    const attachment = message.parts[1].headers;
    const fallback = asciiFileName(fileName);
    expect(fallback).toMatch(/^[\x20-\x7e]+\.epub$/);
    expect(fallback).toContain('Cafe');
    expect(attachment).toContain(`filename="${fallback}"`);
    const extended = /filename\*=UTF-8''([^\s;]+)/.exec(attachment)![1];
    expect(decodeURIComponent(extended)).toBe(fileName);
    expect(new TextDecoder().decode(decodeBase64(message.parts[0].body))).toBe('Olá, ação!');
  });

  it('uses RFC 2231 continuations for very long names', async () => {
    const fileName = `${'漫画'.repeat(120)}.epub`;
    const message = await parse(
      await buildMimeMessage({
        to: 'x@kindle.com',
        subject: 's',
        text: '',
        attachment: { blob: new Blob([]), fileName, mimeType: 'application/epub+zip' },
      }),
    );
    const segments = [...message.parts[1].headers.matchAll(/filename\*(\d+)\*=([^\s;]+)/g)];
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0][2].startsWith("UTF-8''")).toBe(true);
    const joined = segments.map((match) => match[2]).join('').replace("UTF-8''", '');
    expect(decodeURIComponent(joined)).toBe(fileName);
    expect(message.raw.split('\r\n').every((line) => line.length <= 998)).toBe(true);
  });

  it('rejects header injection', async () => {
    await expect(
      buildMimeMessage({ to: 'a@b.c\r\nBcc: evil@x', subject: 's', text: '', attachment: { blob: new Blob([]), fileName: 'a', mimeType: 'text/plain' } }),
    ).rejects.toThrow(TypeError);
  });
});

describe('header helpers', () => {
  it('leaves ASCII untouched and percent-encodes RFC 2231 attr-chars only', () => {
    expect(encodeHeaderText('Plain subject')).toBe('Plain subject');
    expect(rfc2231Encode("a b'é.epub")).toBe('a%20b%27%C3%A9.epub');
  });
});

describe('size math', () => {
  it('computes wrapped base64 sizes', () => {
    expect(base64WrappedLength(0)).toBe(0);
    expect(base64WrappedLength(1)).toBe(6);
    expect(base64WrappedLength(57)).toBe(78);
    expect(base64WrappedLength(58)).toBe(78 + 6);
  });

  it('keeps the largest attachment within the Gmail limit with headroom', () => {
    expect(GMAIL_MAX_MESSAGE_BYTES).toBe(35 * 1024 * 1024);
    const max = maxAttachmentBytes();
    expect(max % 57).toBe(0);
    expect(base64WrappedLength(max)).toBeLessThanOrEqual(GMAIL_MAX_MESSAGE_BYTES - 64 * 1024);
    expect(base64WrappedLength(max + 57 * 900)).toBeGreaterThan(GMAIL_MAX_MESSAGE_BYTES - 64 * 1024);
    expect(max).toBeGreaterThan(26_000_000);
  });
});

// --- Sending -------------------------------------------------------------------

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = '';
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

describe('buildRawJsonBody', () => {
  it('encodes the message as base64url across chunk boundaries', async () => {
    const bytes = randomBytes(3 * 256 * 1024 * 2 + 5);
    const body = await buildRawJsonBody(new Blob([bytes]));
    const text = await body.text();
    expect(text.startsWith('{"raw":"')).toBe(true);
    expect(text).not.toMatch(/[+/=]/);
    expect(new Uint8Array(await (await rawMessage(body)).arrayBuffer())).toEqual(bytes);
  });
});

describe('sendMimeMessage', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    mockedToken.mockReset();
    mockedInvalidate.mockReset();
    mockedToken.mockResolvedValue('token-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the message as JSON raw with the bearer token and progress', async () => {
    const mime = new Blob(['x'.repeat(1000)], { type: 'message/rfc822' });
    const onProgress = vi.fn();
    const promise = sendMimeMessage(mime, { onProgress });

    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(mockedToken).toHaveBeenCalledWith(['gmail'], { interactive: false });
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(xhr.headers).toMatchObject({ Authorization: 'Bearer token-1', 'Content-Type': 'application/json' });
    expect(await (await rawMessage(xhr.body as Blob)).text()).toBe('x'.repeat(1000));
    xhr.upload.onprogress?.({ loaded: 400, total: 1400, lengthComputable: true });
    xhr.respond(200, JSON.stringify({ id: 'm1', threadId: 't1', labelIds: ['SENT'] }));

    await expect(promise).resolves.toEqual({ id: 'm1', threadId: 't1', labelIds: ['SENT'] });
    expect(onProgress).toHaveBeenCalledWith(400, 1400);
  });

  it('retries once with a fresh token after 401', async () => {
    mockedToken.mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    const promise = sendMimeMessage(new Blob(['a']));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    FakeXhr.instances[0].respond(401, '{}');
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    expect(mockedInvalidate).toHaveBeenCalledWith('stale');
    expect(FakeXhr.instances[1].headers.Authorization).toBe('Bearer fresh');
    FakeXhr.instances[1].respond(200, JSON.stringify({ id: 'm', threadId: 't' }));
    await expect(promise).resolves.toEqual({ id: 'm', threadId: 't' });
  });

  it('maps errors, network failures, and aborts', async () => {
    const quota = sendMimeMessage(new Blob(['a']));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    FakeXhr.instances[0].respond(429, JSON.stringify({ error: { message: 'slow down' } }));
    await expect(quota).rejects.toMatchObject({ code: 'quota' });

    const large = sendMimeMessage(new Blob(['a']));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
    FakeXhr.instances[1].respond(413, '{}');
    await expect(large).rejects.toMatchObject({ code: 'too_large' });

    const offline = sendMimeMessage(new Blob(['a']));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(3));
    FakeXhr.instances[2].onerror?.();
    await expect(offline).rejects.toMatchObject({ code: 'network' });

    const controller = new AbortController();
    const aborted = sendMimeMessage(new Blob(['a']), { signal: controller.signal });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(4));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects messages over the Gmail limit without calling Google', async () => {
    const oversized = { size: GMAIL_MAX_MESSAGE_BYTES + 1 } as Blob;
    await expect(sendMimeMessage(oversized)).rejects.toMatchObject({ code: 'too_large' });
    expect(mockedToken).not.toHaveBeenCalled();
  });
});

describe('sendFileByEmail', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    mockedToken.mockReset();
    mockedToken.mockResolvedValue('token-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws too_large up front', async () => {
    const file = { size: maxAttachmentBytes() + 1 } as Blob;
    await expect(
      sendFileByEmail({ to: 'x@kindle.com', subject: 's', text: '', file, fileName: 'a.epub', mimeType: 'application/epub+zip' }),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(mockedToken).not.toHaveBeenCalled();
  });

  it('builds and sends the message', async () => {
    const promise = sendFileByEmail({
      to: 'x@kindle.com',
      subject: 'Vol. 1',
      text: 'hi',
      file: new Blob([new Uint8Array([9, 8, 7])]),
      fileName: 'v1.epub',
      mimeType: 'application/epub+zip',
    });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const message = await parse(await rawMessage(FakeXhr.instances[0].body as Blob));
    expect(decodeBase64(message.parts[1].body)).toEqual(new Uint8Array([9, 8, 7]));
    FakeXhr.instances[0].respond(200, JSON.stringify({ id: 'm', threadId: 't' }));
    await expect(promise).resolves.toEqual({ id: 'm', threadId: 't' });
  });
});
