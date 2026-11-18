import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ authorizedFetch: vi.fn() }));

import { authorizedFetch } from './auth';
import { createDriveStore, deleteAppData, listAppDataFiles, readAppDataJson, writeAppDataJson } from './drive';

const mockedFetch = vi.mocked(authorizedFetch);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function call(index: number): { url: URL; init: RequestInit; interactive: boolean } {
  const [sets, input, init, options] = mockedFetch.mock.calls[index];
  expect(sets).toEqual(['drive']);
  return { url: new URL(String(input)), init: init ?? {}, interactive: options?.interactive ?? false };
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('listAppDataFiles', () => {
  it('lists appDataFolder with limited fields across pages', async () => {
    mockedFetch
      .mockResolvedValueOnce(json({ nextPageToken: 'p2', files: [{ id: '1', name: 'a.json', modifiedTime: 't1' }] }))
      .mockResolvedValueOnce(json({ files: [{ id: '2', name: 'b.json', modifiedTime: 't2' }] }));
    const files = await listAppDataFiles();
    expect(files.map((file) => file.id)).toEqual(['1', '2']);
    const first = call(0).url;
    expect(first.origin + first.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(first.searchParams.get('spaces')).toBe('appDataFolder');
    expect(first.searchParams.get('fields')).toBe('nextPageToken,files(id,name,modifiedTime)');
    expect(call(1).url.searchParams.get('pageToken')).toBe('p2');
  });

  it('maps API errors', async () => {
    mockedFetch.mockResolvedValueOnce(json({ error: { message: 'quota', errors: [{ reason: 'userRateLimitExceeded' }] } }, 403));
    await expect(listAppDataFiles()).rejects.toMatchObject({ code: 'quota' });
  });
});

describe('readAppDataJson', () => {
  it('finds the file by escaped name and downloads it with alt=media', async () => {
    mockedFetch
      .mockResolvedValueOnce(json({ files: [{ id: 'f1', name: "it's.json", modifiedTime: '2026-01-01T00:00:00Z' }] }))
      .mockResolvedValueOnce(json({ version: 1 }));
    await expect(readAppDataJson("it's.json")).resolves.toEqual({ id: 'f1', data: { version: 1 }, modifiedTime: '2026-01-01T00:00:00Z' });
    expect(call(0).url.searchParams.get('q')).toBe("name = 'it\\'s.json' and trashed = false");
    expect(call(1).url.toString()).toBe('https://www.googleapis.com/drive/v3/files/f1?alt=media');
  });

  it('returns null when missing', async () => {
    mockedFetch.mockResolvedValueOnce(json({ files: [] }));
    await expect(readAppDataJson('none.json')).resolves.toBeNull();
  });
});

describe('writeAppDataJson', () => {
  it('creates with a multipart upload into appDataFolder', async () => {
    mockedFetch.mockResolvedValueOnce(json({ id: 'new-id' }));
    await expect(writeAppDataJson('library.json', { a: 1 })).resolves.toBe('new-id');
    const { url, init } = call(0);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/upload/drive/v3/files');
    expect(url.searchParams.get('uploadType')).toBe('multipart');
    expect(init.method).toBe('POST');
    const contentType = (init.headers as Record<string, string>)['Content-Type'];
    const boundary = /boundary=(.+)$/.exec(contentType)![1];
    const body = await (init.body as Blob).text();
    const parts = body.split(`--${boundary}`);
    expect(parts.at(-1)).toBe('--\r\n');
    expect(JSON.parse(parts[1].split('\r\n\r\n')[1])).toEqual({ name: 'library.json', parents: ['appDataFolder'], mimeType: 'application/json' });
    expect(JSON.parse(parts[2].split('\r\n\r\n')[1])).toEqual({ a: 1 });
  });

  it('updates content in place with PATCH uploadType=media', async () => {
    mockedFetch.mockResolvedValueOnce(json({ id: 'f1' }));
    await expect(writeAppDataJson('library.json', { a: 2 }, 'f1')).resolves.toBe('f1');
    const { url, init } = call(0);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/upload/drive/v3/files/f1');
    expect(url.searchParams.get('uploadType')).toBe('media');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"a":2}');
  });

  it('recreates the file when the known id is gone', async () => {
    mockedFetch.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({ id: 'f2' }));
    await expect(writeAppDataJson('library.json', {}, 'f1')).resolves.toBe('f2');
  });
});

describe('deleteAppData', () => {
  it('deletes every appData file, ignoring ones already gone', async () => {
    mockedFetch
      .mockResolvedValueOnce(json({ files: [{ id: '1', name: 'a', modifiedTime: '' }, { id: '2', name: 'b', modifiedTime: '' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({}, 404));
    await expect(deleteAppData({ interactive: true })).resolves.toBe(2);
    expect(call(1).init.method).toBe('DELETE');
    expect(call(1).url.pathname).toBe('/drive/v3/files/1');
    expect(call(2).interactive).toBe(true);
  });
});

describe('createDriveStore', () => {
  it('remembers file ids and falls back to a lookup when a cached id disappears', async () => {
    const store = createDriveStore();
    mockedFetch
      .mockResolvedValueOnce(json({ files: [{ id: 'f1', name: 'library.json', modifiedTime: '' }] }))
      .mockResolvedValueOnce(json({ v: 1 }));
    await expect(store.read('library.json')).resolves.toEqual({ id: 'f1', data: { v: 1 } });

    mockedFetch.mockResolvedValueOnce(json({ v: 2 }));
    await expect(store.read('library.json')).resolves.toEqual({ id: 'f1', data: { v: 2 } });
    expect(call(2).url.toString()).toContain('/files/f1?alt=media');

    mockedFetch.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({ files: [] }));
    await expect(store.read('library.json')).resolves.toBeNull();

    mockedFetch.mockResolvedValueOnce(json({ id: 'f9' }));
    await expect(store.write('library.json', { v: 3 })).resolves.toBe('f9');
    expect(call(5).init.method).toBe('POST');
  });
});
