import { describe, expect, it } from 'vitest';
import { EpubPartWriter, type EpubBookInfo } from './epub';
import { fakeJpeg, localHeaderNames, readEpub } from './test-helpers';

const MODIFIED = new Date(Date.UTC(2026, 10, 17, 12, 0, 0));

function book(overrides: Partial<EpubBookInfo> = {}): EpubBookInfo {
  return {
    title: 'Berserk Vol. 2',
    authors: ['Kentaro Miura'],
    language: 'en',
    direction: 'rtl',
    identifier: 'urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e',
    series: 'Berserk',
    seriesIndex: 2,
    modified: MODIFIED,
    originalResolution: { width: 1272, height: 1696 },
    toc: [{ title: 'Chapter 1', pageIndex: 0 }],
    ...overrides,
  };
}

function build(info: EpubBookInfo, sizes: Array<[number, number]>) {
  const writer = new EpubPartWriter({ language: info.language, modified: MODIFIED });
  sizes.forEach(([width, height], i) => writer.addPage({ bytes: fakeJpeg(500 + i, i), width, height }));
  const projected = writer.projectedSize();
  return { blob: writer.finish(info), projected };
}

describe('EpubPartWriter', () => {
  it('writes mimetype first, stored, with no extra field or data descriptor', async () => {
    const { blob } = build(book(), [[1272, 1696]]);
    const { bytes } = await readEpub(blob);
    const headers = localHeaderNames(bytes);
    expect(headers[0]).toMatchObject({ name: 'mimetype', method: 0, flags: 0, offset: 0 });
    expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe('mimetype');
    expect(new TextDecoder().decode(bytes.subarray(38, 58))).toBe('application/epub+zip');
    expect(new DataView(bytes.buffer).getUint16(28, true)).toBe(0);
    expect(headers.map((h) => h.name)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/style.css',
      'OEBPS/images/p0001.jpg',
      'OEBPS/pages/p0001.xhtml',
      'OEBPS/nav.xhtml',
      'OEBPS/toc.ncx',
      'OEBPS/content.opf',
    ]);
    expect(headers.find((h) => h.name.endsWith('.jpg'))?.method).toBe(0);
    expect(blob.type).toBe('application/epub+zip');
  });

  it('writes the required OPF metadata for an RTL series volume', async () => {
    const { blob } = build(book(), [[1272, 1696], [1000, 1400]]);
    const epub = await readEpub(blob);
    expect(epub.text('META-INF/container.xml')).toContain('full-path="OEBPS/content.opf"');
    const opf = epub.text('OEBPS/content.opf');
    expect(opf).toContain('<dc:identifier id="bookid">urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e</dc:identifier>');
    expect(opf).toContain('<dc:title id="title">Berserk Vol. 2</dc:title>');
    expect(opf).toContain('<dc:creator id="creator1">Kentaro Miura</dc:creator>');
    expect(opf).toContain('<dc:language>en</dc:language>');
    expect(opf).toContain('<meta property="dcterms:modified">2026-11-17T12:00:00Z</meta>');
    expect(opf).toContain('<meta property="belongs-to-collection" id="series">Berserk</meta>');
    expect(opf).toContain('<meta refines="#series" property="collection-type">series</meta>');
    expect(opf).toContain('<meta refines="#series" property="group-position">2</meta>');
    expect(opf).toContain('<meta property="rendition:layout">pre-paginated</meta>');
    expect(opf).toContain('<meta name="fixed-layout" content="true"/>');
    expect(opf).toContain('<meta name="original-resolution" content="1272x1696"/>');
    expect(opf).toContain('<meta name="book-type" content="comic"/>');
    expect(opf).toContain('<meta name="primary-writing-mode" content="horizontal-rl"/>');
    expect(opf).toContain('<spine toc="ncx" page-progression-direction="rtl">');
    // The cover reuses the first page image; no duplicate bytes.
    expect(opf).toContain('<item id="img-0001" href="images/p0001.jpg" media-type="image/jpeg" properties="cover-image"/>');
    expect(opf).toContain('<meta name="cover" content="img-0001"/>');
    expect(Object.keys(epub.files).filter((name) => name.endsWith('.jpg'))).toHaveLength(2);
    expect(opf.match(/<itemref /g)).toHaveLength(2);
    expect(opf).toContain('properties="nav"');
    expect(opf).toContain('media-type="application/x-dtbncx+xml"');
  });

  it('uses LTR progression and writing mode for LTR books', async () => {
    const { blob } = build(book({ direction: 'ltr', series: undefined }), [[1272, 1696]]);
    const opf = (await readEpub(blob)).text('OEBPS/content.opf');
    expect(opf).toContain('page-progression-direction="ltr"');
    expect(opf).toContain('content="horizontal-lr"');
    expect(opf).not.toContain('belongs-to-collection');
  });

  it('gives every page a viewport matching its image', async () => {
    const { blob } = build(book(), [[1272, 1696], [636, 1696], [848, 1696]]);
    const epub = await readEpub(blob);
    const expected = [[1272, 1696], [636, 1696], [848, 1696]];
    expected.forEach(([w, h], i) => {
      const page = epub.text(`OEBPS/pages/p000${i + 1}.xhtml`);
      expect(page).toContain(`<meta name="viewport" content="width=${w}, height=${h}"/>`);
      expect(page).toContain(`<img src="../images/p000${i + 1}.jpg" width="${w}" height="${h}" alt=""/>`);
      expect(page).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    });
  });

  it('escapes metadata text everywhere', async () => {
    const title = `Tom & Jerry <Special> "Vol" 'One' 進撃`;
    const { blob } = build(
      book({ title, authors: ['A & B'], series: 'S<1>', toc: [{ title: 'Ch. 1 & <2>', pageIndex: 0 }] }),
      [[1272, 1696]],
    );
    const epub = await readEpub(blob);
    const escaped = 'Tom &amp; Jerry &lt;Special&gt; &quot;Vol&quot; &apos;One&apos; 進撃';
    expect(epub.text('OEBPS/content.opf')).toContain(`<dc:title id="title">${escaped}</dc:title>`);
    expect(epub.text('OEBPS/content.opf')).toContain('>A &amp; B</dc:creator>');
    expect(epub.text('OEBPS/content.opf')).toContain('>S&lt;1&gt;</meta>');
    expect(epub.text('OEBPS/nav.xhtml')).toContain('>Ch. 1 &amp; &lt;2&gt;</a>');
    expect(epub.text('OEBPS/toc.ncx')).toContain(`<docTitle><text>${escaped}</text></docTitle>`);
    for (const name of ['OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx', 'OEBPS/pages/p0001.xhtml']) {
      const doc = new DOMParser().parseFromString(epub.text(name), 'application/xml');
      expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    }
  });

  it('writes nav TOC, landmarks, page list, and NCX entries', async () => {
    const { blob } = build(
      book({ toc: [{ title: 'Chapter 2', pageIndex: 2 }, { title: 'Chapter 1', pageIndex: 0 }, { title: 'Ghost', pageIndex: 9 }] }),
      [[100, 140], [100, 140], [100, 140]],
    );
    const epub = await readEpub(blob);
    const nav = epub.text('OEBPS/nav.xhtml');
    expect(nav).toMatch(/epub:type="toc"[\s\S]*Chapter 1[\s\S]*Chapter 2/);
    expect(nav).not.toContain('Ghost');
    expect(nav).toContain('<li><a href="pages/p0003.xhtml">Chapter 2</a></li>');
    expect(nav).toContain('epub:type="landmarks"');
    expect(nav).toContain('<a epub:type="cover" href="pages/p0001.xhtml">');
    expect(nav).toContain('<li><a href="pages/p0003.xhtml">3</a></li>');
    const ncx = epub.text('OEBPS/toc.ncx');
    expect(ncx).toContain('playOrder="2"><navLabel><text>Chapter 2</text></navLabel><content src="pages/p0003.xhtml"/>');
  });

  it('falls back to a single TOC entry with the title', async () => {
    const { blob } = build(book({ toc: [] }), [[100, 140]]);
    expect((await readEpub(blob)).text('OEBPS/nav.xhtml')).toContain('<li><a href="pages/p0001.xhtml">Berserk Vol. 2</a></li>');
  });

  it('projects a size that bounds the finished EPUB tightly', () => {
    const { blob, projected } = build(book(), Array.from({ length: 50 }, () => [1272, 1696] as [number, number]));
    expect(projected).toBeGreaterThanOrEqual(blob.size);
    expect(projected - blob.size).toBeLessThan(64 * 1024);
  });
});
