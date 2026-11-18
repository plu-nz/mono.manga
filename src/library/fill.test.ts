import { describe, expect, it } from 'vitest';
import type { ChapterSummary } from '../core/types';
import { fillChapters } from './fill';

const own = (id: string, number?: string, extra: Partial<ChapterSummary> = {}): ChapterSummary => ({ provider: 'mangadex', mangaId: 'm', id, number, language: 'en', pages: 20, ...extra });
const wc = (id: string, number: string): ChapterSummary => ({ provider: 'mangadex', mangaId: 'm', id, number, language: 'en', pages: 1, source: 'weebcentral', groups: ['Weeb Central'] });

describe('fillChapters', () => {
  it('adds only the numbers the provider cannot serve, in reading order', () => {
    const primary = [own('a1', '1'), own('a3', '3'), own('extra'), own('a5', '5')];
    const extra = [wc('w1', '1'), wc('w2', '2'), wc('w3', '3'), wc('w4', '4'), wc('w5', '5'), wc('w6', '6')];
    expect(fillChapters(primary, extra).map(chapter => chapter.id)).toEqual(['a1', 'w2', 'a3', 'extra', 'w4', 'a5', 'w6']);
  });

  it('replaces external-only releases of a number', () => {
    const primary = [own('a1', '1'), own('ext2', '2', { externalUrl: 'https://mangaplus.example/2', pages: 0 }), own('ext9', '9', { externalUrl: 'https://mangaplus.example/9', pages: 0 })];
    const result = fillChapters(primary, [wc('w2', '2')]);
    expect(result.map(chapter => chapter.id)).toEqual(['a1', 'w2', 'ext9']);
  });

  it('returns the provider list untouched when nothing is missing', () => {
    const primary = [own('a1', '1')];
    expect(fillChapters(primary, [wc('w1', '1')])).toBe(primary);
    expect(fillChapters(primary, [])).toBe(primary);
  });
});
