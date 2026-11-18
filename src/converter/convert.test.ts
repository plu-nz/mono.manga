import { describe, expect, it } from 'vitest';
import { convertWithProcessor, outputPageIndex, tocForPart, type ConvertProgress, type EpubJob } from './convert';
import { ConversionError } from './errors';
import { fakeProcessor, pageBlobs, readEpub } from './test-helpers';

const NOW = { now: new Date(Date.UTC(2026, 10, 17, 12, 0, 0)) };

function job(overrides: Partial<EpubJob> = {}): EpubJob {
  return {
    title: 'Berserk Vol. 2',
    series: 'Berserk',
    seriesIndex: 2,
    authors: ['Kentaro Miura'],
    language: 'en',
    direction: 'rtl',
    profileId: 'paperwhite-2024',
    identifier: 'mangadex:berserk:vol-2',
    ...overrides,
  };
}

const PORTRAIT: [number, number] = [1000, 1400];
const SPREAD: [number, number] = [2000, 1400];

describe('TOC index mapping', () => {
  it('maps source pages to output pages after spreads are split', () => {
    const pagesPerSource = [1, 2, 1, 2, 1];
    expect([0, 1, 2, 3, 4].map((i) => outputPageIndex(pagesPerSource, i))).toEqual([0, 1, 3, 4, 6]);
  });

  it('keeps entries inside the part and carries the running chapter', () => {
    const toc = [
      { title: 'Ch 1', pageIndex: 0 },
      { title: 'Ch 2', pageIndex: 3 },
      { title: 'Ch 3', pageIndex: 7 },
    ];
    const first = new Map([[5, 0], [6, 2], [7, 3], [8, 4]]);
    expect(tocForPart(toc, { firstSourcePage: 5, lastSourcePage: 8 }, (s) => first.get(s) ?? 0)).toEqual([
      { title: 'Ch 2', pageIndex: 0 },
      { title: 'Ch 3', pageIndex: 3 },
    ]);
    expect(tocForPart(toc, { firstSourcePage: 3, lastSourcePage: 4 }, (s) => s - 3)).toEqual([{ title: 'Ch 2', pageIndex: 0 }]);
  });
});

describe('convertWithProcessor', () => {
  it('produces a single unsuffixed part with shifted TOC indices after a spread split', async () => {
    const processor = fakeProcessor();
    const progress: ConvertProgress[] = [];
    const parts = await convertWithProcessor(
      job({ toc: [{ title: 'Chapter 10', pageIndex: 0 }, { title: 'Chapter 11', pageIndex: 3 }] }),
      pageBlobs([PORTRAIT, SPREAD, PORTRAIT, PORTRAIT]),
      { total: 4, onProgress: (p) => progress.push(p) },
      processor,
      NOW,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ title: 'Berserk Vol. 2', fileName: 'berserk-vol-2.epub', firstSourcePage: 0, lastSourcePage: 3, pageCount: 5 });
    const epub = await readEpub(parts[0].blob);
    // Source page 3 is output page 4 (index), i.e. p0005, because page 1 was split in two.
    expect(epub.text('OEBPS/nav.xhtml')).toContain('<li><a href="pages/p0005.xhtml">Chapter 11</a></li>');
    expect(epub.text('OEBPS/pages/p0002.xhtml')).toContain('width=1000, height=1400');
    expect(epub.text('OEBPS/content.opf')).toContain('page-progression-direction="rtl"');
    expect(progress.map((p) => p.processed)).toEqual([1, 2, 3, 4]);
    expect(progress.at(-1)).toMatchObject({ total: 4, part: 1 });
    expect(progress.at(-1)!.bytes).toBeGreaterThan(0);
    expect(processor.disposed).toBe(true);
  });

  it('splits into standalone parts under the byte budget', async () => {
    const processor = fakeProcessor({ bytesPerPage: 100_000 });
    const maxPartBytes = 350_000; // room for three 100 kB pages
    const parts = await convertWithProcessor(
      job({ maxPartBytes, toc: [{ title: 'Ch 1', pageIndex: 0 }, { title: 'Ch 2', pageIndex: 5 }] }),
      pageBlobs([PORTRAIT, PORTRAIT, SPREAD, PORTRAIT, PORTRAIT, PORTRAIT, PORTRAIT, PORTRAIT, PORTRAIT]),
      { total: 9 },
      processor,
      NOW,
    );
    expect(parts.map((p) => p.title)).toEqual(parts.map((_, i) => `Berserk Vol. 2 (Part ${i + 1})`));
    expect(parts.map((p) => p.fileName)).toEqual(parts.map((_, i) => `berserk-vol-2-part-${i + 1}.epub`));
    expect(parts.map((p) => [p.firstSourcePage, p.lastSourcePage, p.pageCount])).toEqual([
      [0, 1, 2], // the spread's two halves would not fit, so they move together
      [2, 3, 3],
      [4, 6, 3],
      [7, 8, 2],
    ]);
    const identifiers = new Set<string>();
    for (const [i, part] of parts.entries()) {
      expect(part.blob.size).toBeLessThanOrEqual(maxPartBytes);
      const epub = await readEpub(part.blob);
      const opf = epub.text('OEBPS/content.opf');
      expect(opf).toContain(`<dc:title id="title">Berserk Vol. 2 (Part ${i + 1})</dc:title>`);
      expect(opf).toContain('properties="cover-image"');
      identifiers.add(opf.match(/urn:uuid:[0-9a-f-]+/)![0]);
      expect(Object.keys(epub.files).filter((name) => name.endsWith('.jpg'))).toHaveLength(part.pageCount);
    }
    expect(identifiers.size).toBe(parts.length);
    // Ch 2 starts at source page 5, inside part 3 (source 4..6) at its second page.
    const nav3 = (await readEpub(parts[2].blob)).text('OEBPS/nav.xhtml');
    expect(nav3).toContain('<li><a href="pages/p0001.xhtml">Ch 1</a></li>');
    expect(nav3).toContain('<li><a href="pages/p0002.xhtml">Ch 2</a></li>');
    const nav4 = (await readEpub(parts[3].blob)).text('OEBPS/nav.xhtml');
    expect(nav4).toContain('<li><a href="pages/p0001.xhtml">Ch 2</a></li>');
  });

  it('keeps an oversized page in its own part', async () => {
    const parts = await convertWithProcessor(job({ maxPartBytes: 50_000 }), pageBlobs([PORTRAIT, PORTRAIT]), { total: 2 }, fakeProcessor({ bytesPerPage: 80_000 }), NOW);
    expect(parts.map((p) => p.pageCount)).toEqual([1, 1]);
  });

  it('never splits with an infinite budget and accepts async iterables', async () => {
    async function* pages() {
      for (const blob of pageBlobs(Array.from({ length: 12 }, () => PORTRAIT))) yield blob;
    }
    const parts = await convertWithProcessor(job({ maxPartBytes: Infinity }), pages(), { total: 12 }, fakeProcessor({ bytesPerPage: 100_000 }), NOW);
    expect(parts).toHaveLength(1);
    expect(parts[0].pageCount).toBe(12);
  });

  it('can keep spreads whole', async () => {
    const parts = await convertWithProcessor(job({ splitSpreads: false }), pageBlobs([SPREAD]), { total: 1 }, fakeProcessor(), NOW);
    expect(parts[0].pageCount).toBe(1);
  });

  it('rejects empty input with no_pages', async () => {
    await expect(convertWithProcessor(job(), [], { total: 0 }, fakeProcessor(), NOW)).rejects.toMatchObject({ code: 'no_pages' });
  });

  it('rejects invalid options with invalid_job', async () => {
    await expect(convertWithProcessor(job({ jpegQuality: 2 }), pageBlobs([PORTRAIT]), { total: 1 }, fakeProcessor(), NOW)).rejects.toMatchObject({ code: 'invalid_job' });
  });

  it('aborts, disposes the processor, and stops pulling pages', async () => {
    const controller = new AbortController();
    const processor = fakeProcessor();
    let pulled = 0;
    let closed = false;
    async function* pages() {
      try {
        for (const blob of pageBlobs(Array.from({ length: 10 }, () => PORTRAIT))) {
          pulled++;
          yield blob;
        }
      } finally {
        closed = true;
      }
    }
    const promise = convertWithProcessor(job(), pages(), {
      total: 10,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.processed === 3) controller.abort();
      },
    }, processor, NOW);
    await expect(promise).rejects.toBeInstanceOf(ConversionError);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(processor.disposed).toBe(true);
    expect(pulled).toBe(3);
    await Promise.resolve();
    expect(closed).toBe(true);
  });

  it('propagates processor errors', async () => {
    const processor = fakeProcessor();
    processor.process = async (_blob, _options, pageIndex) => {
      throw new ConversionError('image_decode_failed', 'bad', { pageIndex });
    };
    await expect(convertWithProcessor(job(), pageBlobs([PORTRAIT]), { total: 1 }, processor, NOW)).rejects.toMatchObject({
      code: 'image_decode_failed',
      pageIndex: 0,
    });
    expect(processor.disposed).toBe(true);
  });
});
