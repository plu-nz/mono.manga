import { resetDbForTests } from '../storage/db';
import type { MangaDetails } from '../core/types';

const title = (id: string): MangaDetails => ({ provider: 'mangadex', id, title: `Title ${id}`, defaultMode: 'rtl' });

describe('recent history', () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    resetDbForTests();
    vi.resetModules();
  });

  it('keeps searches unique (case-insensitive), most recent first, capped at 8', async () => {
    const recent = await import('./recent');
    for (const query of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) await recent.addRecentSearch(query);
    await recent.addRecentSearch(' D ');
    expect(recent.recentSearches()).toEqual(['D', 'i', 'h', 'g', 'f', 'e', 'c', 'b']);
    await recent.removeRecentSearch('h');
    expect(recent.recentSearches()).not.toContain('h');
  });

  it('moves a reopened title to the front, survives a reload, and clears', async () => {
    let recent = await import('./recent');
    await recent.addRecentTitle(title('1'));
    await recent.addRecentTitle(title('2'));
    await recent.addRecentTitle(title('1'));
    expect(recent.recentTitles().map(item => item.id)).toEqual(['1', '2']);
    vi.resetModules();
    recent = await import('./recent');
    await recent.loadRecent();
    expect(recent.recentTitles().map(item => item.id)).toEqual(['1', '2']);
    await recent.clearRecent();
    expect(recent.recentTitles()).toEqual([]);
    expect(recent.recentSearches()).toEqual([]);
  });
});
