import { baselineNumber, pickNewChapters } from './auto';
import type { ChapterSummary, ReadingProgress } from '../core/types';

const chapter = (id: string, number: string | undefined, extra: Partial<ChapterSummary> = {}): ChapterSummary => ({
  provider: 'mangadex', mangaId: 'm', id, number, language: 'en', pages: 20, groups: ['A'], ...extra,
});

const chapters = [
  chapter('c1', '1'),
  chapter('c2a', '2', { groups: ['A'] }),
  chapter('c2b', '2', { groups: ['B'], pages: 30 }),
  chapter('c3', '3', { language: 'pt-br' }),
  chapter('c3en', '3', { pages: 10 }),
  chapter('c4', '4', { externalUrl: 'https://example.com' }),
  chapter('c5', '5'),
  chapter('extra', undefined),
];

describe('pickNewChapters', () => {
  it('sends chapters after the last sent number, one release each, preferring the last group and language order', () => {
    const picked = pickNewChapters({ chapters, languages: ['en', 'pt-br'], kindle: { sentIds: ['c1'], lastNumber: 1, lastGroups: ['A'] } });
    expect(picked.map(item => item.id)).toEqual(['c2a', 'c3en', 'c5']);
  });

  it('starts after the chapter being read when nothing was sent', () => {
    const progress: ReadingProgress = { key: 'mangadex:m', chapterId: 'c3', page: 0, pageCount: 20, updatedAt: 1 };
    expect(pickNewChapters({ chapters, languages: ['en'], progress }).map(item => item.id)).toEqual(['c5']);
  });

  it('starts with the latest chapter when there is no history', () => {
    expect(pickNewChapters({ chapters, languages: ['en'] }).map(item => item.id)).toEqual(['c5']);
  });

  it('returns nothing when everything was sent', () => {
    expect(pickNewChapters({ chapters, languages: ['en'], kindle: { sentIds: [], lastNumber: 5 } })).toEqual([]);
  });

  it('never resends a chapter id even below the baseline logic', () => {
    expect(pickNewChapters({ chapters, languages: ['en'], kindle: { sentIds: ['c5'], lastNumber: 4 } })).toEqual([]);
  });
});

describe('baselineNumber', () => {
  it('prefers the sent state over reading progress', () => {
    const progress: ReadingProgress = { key: 'k', chapterId: 'c3', page: 0, pageCount: 1, updatedAt: 1 };
    expect(baselineNumber(chapters, { sentIds: [], lastNumber: 1 }, progress)).toBe(1);
    expect(baselineNumber(chapters, undefined, progress)).toBe(3);
    expect(baselineNumber(chapters)).toBeUndefined();
  });
});
