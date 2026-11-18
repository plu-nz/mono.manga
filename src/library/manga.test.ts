import { adjacentChapter, groupByVolume } from './manga';
import type { ChapterSummary } from '../core/types';

const chapter = (id: string, number?: string, volume?: string, groups: string[] = ['A']): ChapterSummary => ({
  provider: 'mangadex', mangaId: 'm', id, number, volume, language: 'en', pages: 10, groups,
});

describe('groupByVolume', () => {
  it('keeps reading order and splits by consecutive volume', () => {
    const groups = groupByVolume([chapter('1', '1', '1'), chapter('2', '2', '1'), chapter('3', '3', '2'), chapter('4', '4')]);
    expect(groups.map(group => [group.volume, group.chapters.map(item => item.id)])).toEqual([
      ['1', ['1', '2']], ['2', ['3']], [undefined, ['4']],
    ]);
  });
});

describe('adjacentChapter', () => {
  const list = [chapter('1a', '1', '1', ['A']), chapter('1b', '1', '1', ['B']), chapter('2a', '2', '1', ['A']), chapter('2b', '2', '1', ['B']), chapter('3b', '3', '1', ['B'])];

  it('skips other releases of the same number and prefers the same group', () => {
    expect(adjacentChapter(list, list[1], 1)?.id).toBe('2b');
    expect(adjacentChapter(list, list[0], 1)?.id).toBe('2a');
  });

  it('falls back to another group when the same group has no release', () => {
    expect(adjacentChapter(list, list[2], 1)?.id).toBe('3b');
  });

  it('goes backwards', () => {
    expect(adjacentChapter(list, list[3], -1)?.id).toBe('1b');
    expect(adjacentChapter(list, list[0], -1)).toBeUndefined();
  });
});
