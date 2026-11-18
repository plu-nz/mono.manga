import { isKindleAddress, planExports } from './send';
import type { ChapterSummary, MangaDetails } from '../core/types';

const details: MangaDetails = { provider: 'mangadex', id: 'm', title: 'Berserk', defaultMode: 'rtl' };
const chapter = (id: string, number?: string, volume?: string, extra: Partial<ChapterSummary> = {}): ChapterSummary => ({
  provider: 'mangadex', mangaId: 'm', id, number, volume, language: 'en', pages: 20, ...extra,
});

describe('planExports', () => {
  const chapters = [chapter('1', '1', '1'), chapter('2', '2', '1'), chapter('3', '3', '2'), chapter('x', '4', '2', { externalUrl: 'https://example.com' })];

  it('creates one file named after the volume when chapters share it', () => {
    const [plan] = planExports(details, chapters.slice(0, 2), 'single');
    expect(plan.title).toBe('Berserk Vol. 1');
    expect(plan.seriesIndex).toBe(1);
  });

  it('names a chapter range across volumes and skips external chapters', () => {
    const plans = planExports(details, chapters, 'single');
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Berserk Ch. 1–3');
    expect(plans[0].chapters.map(item => item.id)).toEqual(['1', '2', '3']);
  });

  it('groups by volume', () => {
    const plans = planExports(details, chapters, 'volume');
    expect(plans.map(plan => [plan.title, plan.chapters.length])).toEqual([['Berserk Vol. 1', 2], ['Berserk Vol. 2', 1]]);
  });

  it('creates one file per chapter', () => {
    const plans = planExports(details, chapters, 'chapter');
    expect(plans.map(plan => plan.title)).toEqual(['Berserk Vol. 1 Ch. 1', 'Berserk Vol. 1 Ch. 2', 'Berserk Vol. 2 Ch. 3']);
  });
});

describe('isKindleAddress', () => {
  it('accepts Kindle addresses only', () => {
    expect(isKindleAddress('reader_12@kindle.com')).toBe(true);
    expect(isKindleAddress('reader@free.kindle.com')).toBe(true);
    expect(isKindleAddress('reader@gmail.com')).toBe(false);
    expect(isKindleAddress('kindle.com')).toBe(false);
  });
});
