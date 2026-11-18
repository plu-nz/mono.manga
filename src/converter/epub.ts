/**
 * Fixed-layout EPUB 3 builder for comics, tuned for Kindle (Send to Kindle).
 *
 * Conventions follow Kindle Comic Converter's EPUB output: Kindle-specific
 * `<meta name>` entries (fixed-layout, original-resolution, book-type, ...),
 * one XHTML document per image with a viewport matching the image size, and a
 * legacy NCX next to the EPUB 3 navigation document.
 *
 * `EpubPartWriter` streams entries into a ZIP as pages arrive; only the book
 * metadata, TOC, and navigation are written when the part is finished.
 */
import { escapeXml, modifiedTimestamp } from './naming';
import { utf8, ZipWriter, zipEntryOverhead } from './zip';

export interface ProcessedImage {
  /** Encoded JPEG bytes. */
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface EpubTocEntry {
  title: string;
  /** Zero-based page index within this EPUB. */
  pageIndex: number;
}

export interface EpubBookInfo {
  title: string;
  authors: string[];
  language: string;
  direction: 'ltr' | 'rtl';
  /** Full identifier, e.g. `urn:uuid:…`. */
  identifier: string;
  series?: string;
  seriesIndex?: number;
  /** `dcterms:modified`. */
  modified: Date;
  /** Target device resolution (Kindle `original-resolution`). */
  originalResolution: { width: number; height: number };
  toc: EpubTocEntry[];
}

export const EPUB_MIME_TYPE = 'application/epub+zip';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const OPS_NS = 'http://www.idpf.org/2007/ops';
const BLOB_FLUSH_BYTES = 4 * 1024 * 1024;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const STYLE_CSS = `@page { margin: 0; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
body { display: block; overflow: hidden; }
div.page { position: relative; margin: 0; padding: 0; width: 100%; height: 100%; text-align: center; }
div.page img { position: absolute; top: 0; left: 0; display: block; margin: 0; padding: 0; width: 100%; height: 100%; }
`;

function pad(index: number): string {
  return String(index + 1).padStart(4, '0');
}

export function imagePath(index: number): string {
  return `images/p${pad(index)}.jpg`;
}

export function pagePath(index: number): string {
  return `pages/p${pad(index)}.xhtml`;
}

function imageId(index: number): string {
  return `img-${pad(index)}`;
}

function pageId(index: number): string {
  return `page-${pad(index)}`;
}

function languageOf(language: string): string {
  return escapeXml(language.trim() || 'und');
}

/** XHTML document for one page: the image fills a viewport of exactly its size. */
export function pageXhtml(options: { index: number; width: number; height: number; language: string }): string {
  const { index, width, height } = options;
  const lang = languageOf(options.language);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="${OPS_NS}" xml:lang="${lang}" lang="${lang}">
<head>
<title>Page ${index + 1}</title>
<meta name="viewport" content="width=${width}, height=${height}"/>
<link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body>
<div class="page"><img src="../${imagePath(index)}" width="${width}" height="${height}" alt=""/></div>
<div style="display:none;">.</div>
</body>
</html>
`;
}

function sortedToc(info: EpubBookInfo, pageCount: number): EpubTocEntry[] {
  const entries = info.toc
    .filter((entry) => Number.isInteger(entry.pageIndex) && entry.pageIndex >= 0 && entry.pageIndex < pageCount)
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => a.entry.pageIndex - b.entry.pageIndex || a.order - b.order)
    .map(({ entry }) => ({ title: entry.title.trim() || `Page ${entry.pageIndex + 1}`, pageIndex: entry.pageIndex }));
  return entries.length > 0 ? entries : [{ title: info.title, pageIndex: 0 }];
}

export function opfDocument(info: EpubBookInfo, pageCount: number): string {
  const lang = languageOf(info.language);
  const lines: string[] = [];
  lines.push(`<dc:identifier id="bookid">${escapeXml(info.identifier)}</dc:identifier>`);
  lines.push(`<dc:title id="title">${escapeXml(info.title)}</dc:title>`);
  lines.push(`<dc:language>${lang}</dc:language>`);
  info.authors.forEach((author, i) => {
    lines.push(`<dc:creator id="creator${i + 1}">${escapeXml(author)}</dc:creator>`);
    lines.push(`<meta refines="#creator${i + 1}" property="role" scheme="marc:relators">aut</meta>`);
  });
  lines.push(`<meta property="dcterms:modified">${modifiedTimestamp(info.modified)}</meta>`);
  if (info.series) {
    lines.push(`<meta property="belongs-to-collection" id="series">${escapeXml(info.series)}</meta>`);
    lines.push(`<meta refines="#series" property="collection-type">series</meta>`);
    if (info.seriesIndex !== undefined && Number.isFinite(info.seriesIndex)) {
      lines.push(`<meta refines="#series" property="group-position">${info.seriesIndex}</meta>`);
    }
    lines.push(`<meta name="calibre:series" content="${escapeXml(info.series)}"/>`);
    if (info.seriesIndex !== undefined && Number.isFinite(info.seriesIndex)) {
      lines.push(`<meta name="calibre:series_index" content="${info.seriesIndex}"/>`);
    }
  }
  lines.push(`<meta property="rendition:layout">pre-paginated</meta>`);
  lines.push(`<meta property="rendition:orientation">portrait</meta>`);
  lines.push(`<meta property="rendition:spread">none</meta>`);
  lines.push(`<meta name="cover" content="${imageId(0)}"/>`);
  // Kindle-specific metadata (KindleGen / KCC conventions).
  lines.push(`<meta name="fixed-layout" content="true"/>`);
  lines.push(`<meta name="original-resolution" content="${info.originalResolution.width}x${info.originalResolution.height}"/>`);
  lines.push(`<meta name="book-type" content="comic"/>`);
  lines.push(`<meta name="primary-writing-mode" content="${info.direction === 'rtl' ? 'horizontal-rl' : 'horizontal-lr'}"/>`);
  lines.push(`<meta name="zero-gutter" content="true"/>`);
  lines.push(`<meta name="zero-margin" content="true"/>`);
  lines.push(`<meta name="ke-border-color" content="#FFFFFF"/>`);
  lines.push(`<meta name="ke-border-width" content="0"/>`);
  lines.push(`<meta name="orientation-lock" content="portrait"/>`);
  lines.push(`<meta name="region-mag" content="false"/>`);

  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
  ];
  const spine: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    manifest.push(`<item id="${imageId(i)}" href="${imagePath(i)}" media-type="image/jpeg"${i === 0 ? ' properties="cover-image"' : ''}/>`);
    manifest.push(`<item id="${pageId(i)}" href="${pagePath(i)}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${pageId(i)}" linear="yes"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${lines.join('\n')}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx" page-progression-direction="${info.direction}">
${spine.join('\n')}
</spine>
</package>
`;
}

export function navDocument(info: EpubBookInfo, pageCount: number): string {
  const lang = languageOf(info.language);
  const toc = sortedToc(info, pageCount)
    .map((entry) => `<li><a href="${pagePath(entry.pageIndex)}">${escapeXml(entry.title)}</a></li>`)
    .join('\n');
  const pages: string[] = [];
  for (let i = 0; i < pageCount; i++) pages.push(`<li><a href="${pagePath(i)}">${i + 1}</a></li>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="${OPS_NS}" xml:lang="${lang}" lang="${lang}">
<head>
<title>${escapeXml(info.title)}</title>
</head>
<body>
<nav epub:type="toc" id="toc">
<ol>
${toc}
</ol>
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<ol>
<li><a epub:type="cover" href="${pagePath(0)}">Cover</a></li>
<li><a epub:type="bodymatter" href="${pagePath(0)}">Start</a></li>
</ol>
</nav>
<nav epub:type="page-list" id="page-list" hidden="hidden">
<ol>
${pages.join('\n')}
</ol>
</nav>
</body>
</html>
`;
}

export function ncxDocument(info: EpubBookInfo, pageCount: number): string {
  const points = sortedToc(info, pageCount)
    .map(
      (entry, i) =>
        `<navPoint id="nav-${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(entry.title)}</text></navLabel><content src="${pagePath(entry.pageIndex)}"/></navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${languageOf(info.language)}">
<head>
<meta name="dtb:uid" content="${escapeXml(info.identifier)}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escapeXml(info.title)}</text></docTitle>
<navMap>
${points}
</navMap>
</ncx>
`;
}

/** Generous upper bound for the OPF, nav, and NCX entries written by `finish()`. */
function finalEntriesReserve(pageCount: number, tocReserve: number): number {
  return (
    zipEntryOverhead('OEBPS/content.opf') +
    zipEntryOverhead('OEBPS/nav.xhtml') +
    zipEntryOverhead('OEBPS/toc.ncx') +
    8192 +
    600 * pageCount +
    tocReserve
  );
}

/** Bytes to reserve for TOC entries, assuming they are stored uncompressed and heavily escaped. */
export function tocReserveBytes(entries: ReadonlyArray<{ title: string }>): number {
  return entries.reduce((sum, entry) => sum + 400 + 12 * entry.title.length, 0);
}

/**
 * One standalone EPUB being written. Pages are streamed into the ZIP as they
 * are added; `projectedSize` predicts the finished size so callers can split
 * books before a part grows past a byte budget.
 */
export class EpubPartWriter {
  private readonly zip: ZipWriter;
  private readonly blobParts: Blob[] = [];
  private chunks: Uint8Array[] = [];
  private chunkBytes = 0;
  private pages = 0;

  constructor(private readonly options: { language: string; modified: Date; tocReserve?: number }) {
    this.zip = new ZipWriter((chunk) => this.collect(chunk), options.modified);
    // The OCF requires `mimetype` first and stored; the rest may follow in any order.
    this.zip.addStored('mimetype', utf8(EPUB_MIME_TYPE));
    this.zip.addDeflated('META-INF/container.xml', CONTAINER_XML);
    this.zip.addDeflated('OEBPS/style.css', STYLE_CSS);
  }

  get pageCount(): number {
    return this.pages;
  }

  /** Exact bytes written so far (finished size minus central directory and final entries). */
  get bytesWritten(): number {
    return this.zip.bytesWritten;
  }

  /** Upper bound of the finished EPUB size if `images` were added next. */
  projectedSize(images: ReadonlyArray<ProcessedImage> = []): number {
    let size = this.zip.projectedSize;
    let index = this.pages;
    for (const image of images) {
      size += zipEntryOverhead(`OEBPS/${imagePath(index)}`) + image.bytes.length;
      size += zipEntryOverhead(`OEBPS/${pagePath(index)}`);
      size += utf8(pageXhtml({ index, width: image.width, height: image.height, language: this.options.language })).length;
      index++;
    }
    return size + finalEntriesReserve(index, this.options.tocReserve ?? 0);
  }

  /** Writes one page (image + XHTML) and returns its page index in this EPUB. */
  addPage(image: ProcessedImage): number {
    const index = this.pages;
    this.zip.addStored(`OEBPS/${imagePath(index)}`, image.bytes);
    this.zip.addDeflated(
      `OEBPS/${pagePath(index)}`,
      pageXhtml({ index, width: image.width, height: image.height, language: this.options.language }),
    );
    this.pages++;
    return index;
  }

  /** Writes navigation and the package document, then returns the EPUB. */
  finish(info: Omit<EpubBookInfo, 'modified'> & { modified?: Date }): Blob {
    if (this.pages === 0) throw new Error('An EPUB needs at least one page.');
    const book: EpubBookInfo = { ...info, modified: info.modified ?? this.options.modified };
    this.zip.addDeflated('OEBPS/nav.xhtml', navDocument(book, this.pages));
    this.zip.addDeflated('OEBPS/toc.ncx', ncxDocument(book, this.pages));
    this.zip.addDeflated('OEBPS/content.opf', opfDocument(book, this.pages));
    this.zip.finish();
    this.flush();
    return new Blob(this.blobParts, { type: EPUB_MIME_TYPE });
  }

  private collect(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.chunkBytes += chunk.length;
    // Fold chunks into Blobs regularly so engines that page Blobs to disk can release memory.
    if (this.chunkBytes >= BLOB_FLUSH_BYTES) this.flush();
  }

  private flush(): void {
    if (this.chunks.length === 0) return;
    this.blobParts.push(new Blob(this.chunks as BlobPart[]));
    this.chunks = [];
    this.chunkBytes = 0;
  }
}
