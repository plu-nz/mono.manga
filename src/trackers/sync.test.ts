import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChapterSummary, MangaDetails } from '../core/types';

const details = {
  provider: 'mangadex', id: 'm1', title: 'Kingdom', defaultMode: 'rtl',
  links: [{ label: 'MangaDex', url: 'https://mangadex.org/title/m1' }, { label: 'AniList', url: 'https://anilist.co/manga/31642' }],
} as MangaDetails;
const chapter = (id: string, number?: string): ChapterSummary => ({ provider: 'mangadex', mangaId: 'm1', id, number, language: 'en', pages: 10 });
const chapters = [chapter('c1', '1'), chapter('c2', '2'), chapter('c25', '2.5'), chapter('c3', '3'), chapter('c4', '4')];

interface Call { query: string; variables: Record<string, unknown>; auth: string | null }

function mockAniList(entry: { progress: number; status?: string } | null) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ query: body.query, variables: body.variables, auth: new Headers(init.headers).get('Authorization') });
    if (body.query.includes('SaveMediaListEntry')) return Response.json({ data: { SaveMediaListEntry: { id: 1 } } });
    return Response.json({ data: { Media: { mediaListEntry: entry } } });
  }));
  return calls;
}

async function setup() {
  vi.resetModules();
  indexedDB = new IDBFactory();
  const db = await import('../storage/db');
  await db.setKv('tracker.anilist', { token: 'tok', expiresAt: Date.now() + 1e9, userId: 7, userName: 'reader' });
  const store = await import('../library/store');
  await store.loadLibrary();
  const sync = await import('./sync');
  return { store, sync };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('AniList tracker sync', () => {
  it('finds the AniList id in provider links', async () => {
    const { sync } = await setup();
    expect(sync.aniListId(details)).toBe(31642);
    expect(sync.aniListId({ links: [] })).toBeUndefined();
  });

  it('pushes the highest whole chapter read and never lowers AniList', async () => {
    const { store, sync } = await setup();
    await store.setChaptersRead('mangadex:m1', ['c1', 'c2', 'c25'], true);
    let calls = mockAniList({ progress: 1, status: 'PLANNING' });
    expect(await sync.pushToAniList(details, chapters)).toBe(true);
    const save = calls.find(call => call.query.includes('SaveMediaListEntry'))!;
    expect(save.variables).toEqual({ mediaId: 31642, progress: 2, status: 'CURRENT' });
    expect(save.auth).toBe('Bearer tok');

    await store.setChaptersRead('mangadex:m1', ['c3'], true);
    calls = mockAniList({ progress: 10, status: 'COMPLETED' });
    expect(await sync.pushToAniList(details, chapters)).toBe(false);
    expect(calls.some(call => call.query.includes('SaveMediaListEntry'))).toBe(false);
  });

  it('pulls AniList progress without overriding chapters marked unread here', async () => {
    const { store, sync } = await setup();
    await store.setChaptersRead('mangadex:m1', ['c2'], false);
    mockAniList({ progress: 3, status: 'CURRENT' });
    expect(await sync.pullFromAniList(details, chapters)).toBe(3);
    expect(['c1', 'c2', 'c25', 'c3', 'c4'].map(id => store.isChapterRead('mangadex:m1', id))).toEqual([true, false, true, true, false]);
  });

  it('does nothing without a linked account', async () => {
    const { sync } = await setup();
    const db = await import('../storage/db');
    await db.setKv('tracker.anilist', undefined);
    vi.resetModules();
    const fresh = await import('./sync');
    const calls = mockAniList(null);
    expect(await fresh.pullFromAniList(details, chapters)).toBe(0);
    expect(calls).toHaveLength(0);
    void sync;
  });
});
