import { resetDbForTests } from '../storage/db';
import type { MangaDetails } from '../core/types';

const details: MangaDetails = { provider: 'mangadex', id: 'abc', title: 'Title', defaultMode: 'rtl' };

describe('library store', () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    resetDbForTests();
    vi.resetModules();
  });

  it('adds, favorites, and removes titles with tombstones for sync', async () => {
    const store = await import('./store');
    await store.loadLibrary();
    await store.addToLibrary(details);
    expect(store.isInLibrary('mangadex:abc')).toBe(true);
    await store.toggleFavorite(details);
    expect(store.library['mangadex:abc'].favorite).toBe(true);
    await store.removeFromLibrary('mangadex:abc');
    expect(store.isInLibrary('mangadex:abc')).toBe(false);
    const synced = await store.readCollection('library');
    expect(synced['mangadex:abc']).toMatchObject({ deleted: true });
  });

  it('marks a chapter read when the last page is reached and keeps local imports out of sync', async () => {
    const store = await import('./store');
    await store.loadLibrary();
    const chapter = { provider: 'mangadex' as const, mangaId: 'abc', id: 'c1', language: 'en', pages: 3 };
    await store.saveProgress({ key: 'mangadex:abc', chapter, chapterLabel: 'Ch. 1', page: 2, pageCount: 3 });
    expect(store.isChapterRead('mangadex:abc', 'c1')).toBe(true);
    await store.setChaptersRead('mangadex:abc', ['c1'], false);
    expect(store.isChapterRead('mangadex:abc', 'c1')).toBe(false);
    expect((await store.readCollection('progress'))['mangadex:abc']).toMatchObject({ read: [], chapters: { c1: { read: false } } });
    await store.addToLibrary({ ...details, provider: 'local', id: 'mine' });
    expect(Object.keys(await store.readCollection('library'))).toEqual([]);
  });

  it('applies remote settings and resolves the reading mode', async () => {
    const store = await import('./store');
    await store.loadLibrary();
    expect(store.effectiveMode('mangadex:abc', 'rtl')).toBe('rtl');
    await store.applyCollection('settings', { settings: { updatedAt: 5, languages: ['pt-br'], defaultMode: 'vertical', dataSaver: true, showMature: false } as never });
    expect(store.settings.languages).toEqual(['pt-br']);
    expect(store.effectiveMode('mangadex:abc', 'rtl')).toBe('vertical');
  });

  it('keeps stored settings when a setting is saved before loading finishes', async () => {
    const { writeSettings } = await import('../storage/db');
    await writeSettings({ updatedAt: 1, languages: ['pt-br'], defaultMode: 'rtl', dataSaver: false, showMature: false, kindleModel: 'oasis' });
    const store = await import('./store');
    await store.updateSettings({ kindleEmail: 'reader@kindle.com' });
    expect(store.settings).toMatchObject({ languages: ['pt-br'], kindleModel: 'oasis', kindleEmail: 'reader@kindle.com' });
  });

  it('records chapters sent to the Kindle with the highest number as baseline', async () => {
    const store = await import('./store');
    await store.loadLibrary();
    const chapter = (id: string, number: string) => ({ provider: 'mangadex' as const, mangaId: 'abc', id, number, language: 'en', pages: 5, groups: ['G'] });
    await store.markSentToKindle(details, [chapter('c9', '9'), chapter('c10', '10')]);
    expect(store.isInLibrary('mangadex:abc')).toBe(true);
    expect(store.library['mangadex:abc'].kindle).toMatchObject({ sentIds: ['c9', 'c10'], lastNumber: 10, lastGroups: ['G'] });
    await store.markSentToKindle(details, [chapter('c3', '3')]);
    expect(store.library['mangadex:abc'].kindle).toMatchObject({ sentIds: ['c9', 'c10', 'c3'], lastNumber: 10 });
    expect(store.isSentToKindle('mangadex:abc', 'c3')).toBe(true);
    const synced = await store.readCollection('library');
    expect((synced['mangadex:abc'] as { kindle?: unknown }).kindle).toBeTruthy();
  });
});
