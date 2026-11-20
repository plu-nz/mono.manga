import { describe, expect, it } from 'vitest';
import type { MangaSummary } from '../core/types';
import { matchTitle, normalizeTitle, searchNames } from './auto-fill';

const result = (id: string, title: string): MangaSummary => ({ provider: 'weebcentral', id, title });

describe('auto-fill matching', () => {
  it('normalizes case, accents, punctuation, and spacing', () => {
    expect(normalizeTitle('Kingdom!')).toBe('kingdom');
    expect(normalizeTitle('Pokémon: Adventures')).toBe('pokemonadventures');
    expect(normalizeTitle('ONE PIECE')).toBe(normalizeTitle('One Piece'));
  });

  it('links only an exact match against the title or its other names', () => {
    const results = [result('a', 'Kingdom Hearts'), result('b', 'Kingdom'), result('c', 'Kingdom')];
    expect(matchTitle(['Kingdom'], results)?.id).toBe('b');
    expect(matchTitle(['Shingeki no Kyojin', 'Attack on Titan'], [result('x', 'Attack on Titan')])?.id).toBe('x');
    expect(matchTitle(['Kingdom'], [result('a', 'Kingdom Hearts')])).toBeUndefined();
  });

  it('searches with the title, then distinct Latin-script alternative names', () => {
    expect(searchNames({ title: 'Shingeki no Kyojin', altTitles: ['進撃の巨人', 'Attack on Titan', 'shingeki no kyojin!'] }))
      .toEqual(['Shingeki no Kyojin', 'Attack on Titan']);
  });
});
