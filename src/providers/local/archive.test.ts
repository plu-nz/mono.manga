// @vitest-environment node
import { Zip, ZipDeflate, ZipPassThrough, strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, test } from 'vitest';
import { ProviderError } from '../errors';
import { parseComicArchive, parseComicInfo, parseImageFiles, titleFromFileName } from './archive';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8]);

function zip(files: Zippable, level: 0 | 6 = 6): Blob {
  return new Blob([zipSync(files, { level }) as BlobPart]);
}

const COMIC_INFO = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <!-- <Title>Commented out</Title> -->
  <Title>The Beginning &amp; More</Title>
  <Series>Yotsuba&amp;!</Series>
  <Number>12.5</Number>
  <Volume>2</Volume>
  <Writer>Azuma Kiyohiko</Writer>
  <Penciller>Azuma Kiyohiko, Assistant</Penciller>
  <LanguageISO>en</LanguageISO>
  <Manga>YesAndRightToLeft</Manga>
</ComicInfo>`;

describe('parseComicArchive', () => {
  test('keeps images in natural order with correct types and reads ComicInfo.xml', async () => {
    const archive = zip({
      'ComicInfo.xml': strToU8(COMIC_INFO),
      'Chapter 1/page10.jpg': JPEG,
      'Chapter 1/page2.png': PNG,
      'Chapter 1/page1.JPEG': JPEG,
      'Chapter 1/notes.txt': strToU8('hi'),
      '__MACOSX/Chapter 1/._page1.jpg': JPEG,
      'Chapter 1/.hidden.jpg': JPEG,
      'Thumbs.db': strToU8('x'),
      'cover.webp': JPEG,
    });
    const parsed = await parseComicArchive(archive, 'yotsuba_v02.cbz');
    expect(parsed.pages.map(page => page.name)).toEqual(['Chapter 1/page1.JPEG', 'Chapter 1/page2.png', 'Chapter 1/page10.jpg', 'cover.webp']);
    expect(parsed.pages.map(page => page.blob.type)).toEqual(['image/jpeg', 'image/png', 'image/jpeg', 'image/webp']);
    expect(new Uint8Array(await parsed.pages[1].blob.arrayBuffer())).toEqual(PNG);
    expect(parsed).toMatchObject({
      title: 'The Beginning & More',
      series: 'Yotsuba&!',
      number: '12.5',
      volume: '2',
      authors: ['Azuma Kiyohiko', 'Assistant'],
      language: 'en',
      direction: 'rtl',
    });
  });

  test('falls back to the file name and works with stored entries', async () => {
    const parsed = await parseComicArchive(zip({ '001.jpg': JPEG, '002.jpg': JPEG }, 0), 'One_Piece__v01.zip');
    expect(parsed.title).toBe('One Piece v01');
    expect(parsed.series).toBeUndefined();
    expect(parsed.direction).toBeUndefined();
    expect(parsed.pages).toHaveLength(2);
  });

  test('reads streamed archives with data descriptors (stored and deflated)', async () => {
    const chunks: Uint8Array[] = [];
    const writer = new Zip((error, data) => {
      if (error) throw error;
      chunks.push(data);
    });
    const stored = new ZipPassThrough('b/page2.jpg');
    const deflated = new ZipDeflate('b/page10.png', { level: 6 });
    writer.add(stored);
    stored.push(JPEG, true);
    writer.add(deflated);
    deflated.push(PNG, true);
    writer.end();
    const parsed = await parseComicArchive(new Blob(chunks as BlobPart[]), 'streamed.cbz');
    expect(parsed.pages.map(page => page.name)).toEqual(['b/page2.jpg', 'b/page10.png']);
    expect(new Uint8Array(await parsed.pages[0].blob.arrayBuffer())).toEqual(JPEG);
    expect(new Uint8Array(await parsed.pages[1].blob.arrayBuffer())).toEqual(PNG);
  });

  test('throws empty_archive when there are no images', async () => {
    const error = await parseComicArchive(zip({ 'readme.txt': strToU8('nothing') }), 'empty.cbz').catch(e => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('empty_archive');
  });

  test('rejects RAR and other formats as unsupported', async () => {
    const rar = new Blob([new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])]);
    await expect(parseComicArchive(rar, 'volume.cbr')).rejects.toMatchObject({ code: 'unsupported_format' });
    await expect(parseComicArchive(rar, 'mislabelled.cbz')).rejects.toMatchObject({ code: 'unsupported_format' });
    await expect(parseComicArchive(zip({ 'a.jpg': JPEG }), 'renamed.cbr')).rejects.toMatchObject({ code: 'unsupported_format' });
  });

  test('rejects corrupt ZIP data as unsupported', async () => {
    const bytes = zipSync({ 'a.jpg': new Uint8Array(4096).fill(7) }, { level: 6 });
    const corrupt = bytes.slice(0, 40);
    await expect(parseComicArchive(new Blob([corrupt as BlobPart]), 'broken.cbz')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('parseComicInfo', () => {
  test('ignores unknown volume and non-RTL manga flags', () => {
    expect(parseComicInfo('<ComicInfo><Volume>-1</Volume><Manga>Yes</Manga><Series><![CDATA[A & B]]></Series></ComicInfo>')).toEqual({ series: 'A & B' });
  });
});

describe('parseImageFiles', () => {
  test('sorts loose images naturally and labels types', () => {
    const files = [
      new File([JPEG], 'p10.jpg', { type: 'image/jpeg' }),
      new File([PNG], 'p2.png', { type: '' }),
      new File([JPEG], 'p1.jpg', { type: 'image/jpeg' }),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      new File([JPEG], '.DS_Store.jpg', { type: 'image/jpeg' }),
    ];
    const parsed = parseImageFiles(files, 'My_Manga Vol.2');
    expect(parsed.title).toBe('My Manga Vol.2');
    expect(parsed.pages.map(page => page.name)).toEqual(['p1.jpg', 'p2.png', 'p10.jpg']);
    expect(parsed.pages[1].blob.type).toBe('image/png');
  });

  test('throws empty_archive without images', () => {
    expect(() => parseImageFiles([new File(['x'], 'a.txt')], 'x')).toThrow(expect.objectContaining({ code: 'empty_archive' }));
  });

  test('titles from file names', () => {
    expect(titleFromFileName('dir/Some_Title  Ch.5.cbz')).toBe('Some Title Ch.5');
    expect(titleFromFileName('.cbz')).toBe('Untitled');
  });
});
