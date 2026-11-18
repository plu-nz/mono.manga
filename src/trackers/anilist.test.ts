import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

async function fresh() {
  vi.resetModules();
  indexedDB = new IDBFactory();
  return import('./anilist');
}

describe('AniList connect callback', () => {
  it('refuses a token this browser did not ask for', async () => {
    const anilist = await fresh();
    await expect(anilist.completeAniListConnect('#access_token=x&expires_in=60')).rejects.toMatchObject({ code: 'tracker_auth' });
    expect(anilist.aniListAccount()).toBeUndefined();
  });

  it('stores the account after a connect started here', async () => {
    const anilist = await fresh();
    localStorage.setItem('plunz-manga.anilist-pending', String(Date.now()));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { Viewer: { id: 7, name: 'reader' } } })));
    const account = await anilist.completeAniListConnect('#access_token=tok&token_type=Bearer&expires_in=31536000');
    expect(account).toMatchObject({ token: 'tok', userId: 7, userName: 'reader' });
    const reloaded = await import('../storage/db').then(db => db.getKv('tracker.anilist'));
    expect(reloaded).toMatchObject({ token: 'tok' });
    await anilist.disconnectAniList();
    expect(anilist.aniListAccount()).toBeUndefined();
  });
});
