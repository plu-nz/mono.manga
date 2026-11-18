import { describe, expect, it } from 'vitest';
import { bookIdentifier, epubFileName, escapeXml, modifiedTimestamp, partTitle, slugify, uuidFromSeed } from './naming';

describe('naming', () => {
  it('escapes XML and drops forbidden characters', () => {
    expect(escapeXml(`Tom & Jerry <"vol" 'one'>`)).toBe('Tom &amp; Jerry &lt;&quot;vol&quot; &apos;one&apos;&gt;');
    expect(escapeXml('a\u0000b\u001Fc\uD800d')).toBe('abcd');
    expect(escapeXml('進撃の巨人 😀')).toBe('進撃の巨人 😀');
  });

  it('slugifies titles to ASCII', () => {
    expect(slugify('Berserk Vol. 2')).toBe('berserk-vol-2');
    expect(slugify('  Pokémon: Adventures!! ')).toBe('pokemon-adventures');
    expect(slugify('進撃の巨人')).toBe('');
  });

  it('builds short file names with part suffixes', () => {
    expect(epubFileName('Berserk Vol. 2')).toBe('berserk-vol-2.epub');
    expect(epubFileName('Berserk Vol. 2', 1)).toBe('berserk-vol-2-part-1.epub');
    expect(epubFileName('進撃の巨人')).toBe('manga.epub');
    const long = epubFileName('A very long title '.repeat(10), 12);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toMatch(/^[a-z0-9-]+-part-12\.epub$/);
    expect(long).not.toMatch(/--/);
  });

  it('suffixes part titles', () => {
    expect(partTitle('Berserk Vol. 2', undefined)).toBe('Berserk Vol. 2');
    expect(partTitle('Berserk Vol. 2', 3)).toBe('Berserk Vol. 2 (Part 3)');
  });

  it('derives stable, distinct UUIDs', () => {
    const a = uuidFromSeed('mangadex:abc');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFromSeed('mangadex:abc')).toBe(a);
    expect(uuidFromSeed('mangadex:abd')).not.toBe(a);
    expect(bookIdentifier('mangadex:abc')).toBe(`urn:uuid:${a}`);
    expect(bookIdentifier('mangadex:abc', 1)).not.toBe(bookIdentifier('mangadex:abc', 2));
    expect(bookIdentifier('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe('urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('formats dcterms:modified without milliseconds', () => {
    expect(modifiedTimestamp(new Date(Date.UTC(2026, 10, 17, 9, 5, 7, 123)))).toBe('2026-11-17T09:05:07Z');
  });
});
