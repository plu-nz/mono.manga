/**
 * Reads comic archives (CBZ/ZIP) and loose image files the user imports.
 * Runs on the main thread or in a worker: no DOM APIs.
 */
import { Unzip, UnzipInflate, unzipSync, type UnzipFile } from 'fflate';
import { ProviderError } from '../errors';

export interface ParsedArchive {
  title: string;
  series?: string;
  volume?: string;
  number?: string;
  authors?: string[];
  direction?: 'ltr' | 'rtl';
  language?: string;
  pages: Array<{ name: string; blob: Blob }>;
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

const UNSUPPORTED_EXTENSIONS = /\.(?:cbr|rar|cb7|7z|cbt|tar|cba|ace|pdf)$/i;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function extension(name: string): string {
  const match = /\.([^./\\]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

export function imageMimeType(name: string): string | undefined {
  return IMAGE_TYPES[extension(name)];
}

/** Skips macOS resource forks, hidden files, and OS thumbnails. */
function isIgnored(path: string): boolean {
  const segments = path.split(/[\\/]/);
  return segments.some(segment => segment === '__MACOSX' || segment.startsWith('.')) || /^(?:thumbs\.db|desktop\.ini)$/i.test(segments.at(-1) ?? '');
}

function isImageEntry(path: string): boolean {
  return !path.endsWith('/') && !isIgnored(path) && imageMimeType(path) !== undefined;
}

function isComicInfo(path: string): boolean {
  return !isIgnored(path) && /(?:^|[\\/])comicinfo\.xml$/i.test(path);
}

/** Natural order by full path: `page2` before `page10`. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** "One_Piece_v01.cbz" → "One Piece v01". */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  // Only strip known extensions so names like "Vol.2" keep their number.
  const title = base.replace(/\.(?:cbz|zip|cbr|rar|cb7|7z|cbt|tar|pdf|jpe?g|png|webp|gif|avif)$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return title || 'Untitled';
}

// --- ComicInfo.xml ----------------------------------------------------------

export interface ComicInfo {
  title?: string;
  series?: string;
  number?: string;
  volume?: string;
  authors?: string[];
  language?: string;
  direction?: 'ltr' | 'rtl';
}

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name: string) => {
      switch (name.toLowerCase()) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
      }
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .trim();
}

function xmlField(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`).exec(xml);
  const value = match ? decodeXml(match[1]) : '';
  return value || undefined;
}

/** Small regex-based reader for the ComicRack `ComicInfo.xml` schema. */
export function parseComicInfo(xml: string): ComicInfo {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const info: ComicInfo = {};
  const title = xmlField(body, 'Title');
  const series = xmlField(body, 'Series');
  const number = xmlField(body, 'Number');
  const volume = xmlField(body, 'Volume');
  const language = xmlField(body, 'LanguageISO');
  if (title) info.title = title;
  if (series) info.series = series;
  if (number) info.number = number;
  // ComicRack writes -1 for "unknown" volume.
  if (volume && volume !== '-1') info.volume = volume;
  if (language) info.language = language;
  const people = ['Writer', 'Penciller']
    .flatMap(tag => (xmlField(body, tag) ?? '').split(/[,;]/))
    .map(name => name.trim())
    .filter(Boolean);
  if (people.length) info.authors = [...new Set(people)];
  if (xmlField(body, 'Manga')?.toLowerCase() === 'yesandrighttoleft') info.direction = 'rtl';
  return info;
}

// --- Archives ---------------------------------------------------------------

interface Entries {
  images: Array<{ name: string; parts: Uint8Array[] }>;
  comicInfo?: { name: string; parts: Uint8Array[] };
}

function wanted(name: string): 'image' | 'info' | undefined {
  if (isImageEntry(name)) return 'image';
  if (isComicInfo(name)) return 'info';
  return undefined;
}

function keepComicInfo(entries: Entries, name: string, parts: Uint8Array[]): void {
  // Prefer the shallowest ComicInfo.xml (normally the archive root).
  const depth = (path: string) => path.split('/').length;
  if (!entries.comicInfo || depth(name) < depth(entries.comicInfo.name)) entries.comicInfo = { name, parts };
}

/** Streams the archive so large CBZs never need a second full copy in memory. */
async function readStreaming(file: Blob): Promise<Entries> {
  const entries: Entries = { images: [] };
  let failure: unknown;
  const unzip = new Unzip((entry: UnzipFile) => {
    const kind = wanted(entry.name);
    if (!kind) return; // Not started: the entry is skipped without decompressing.
    const parts: Uint8Array[] = [];
    entry.ondata = (error, data, final) => {
      if (error) {
        failure ??= error;
        return;
      }
      if (data.length) parts.push(data);
      if (final) {
        if (kind === 'image') entries.images.push({ name: entry.name, parts });
        else keepComicInfo(entries, entry.name, parts);
      }
    };
    try {
      entry.start();
    } catch (error) {
      failure ??= error;
    }
  });
  unzip.register(UnzipInflate);
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (failure) {
      await reader.cancel().catch(() => undefined);
      throw failure;
    }
    if (done) {
      unzip.push(new Uint8Array(0), true);
      break;
    }
    unzip.push(value);
  }
  if (failure) throw failure;
  return entries;
}

/**
 * Fallback for archives the streaming reader cannot handle (for example
 * stored entries with data descriptors): reads the central directory.
 */
async function readWhole(file: Blob): Promise<Entries> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: entry => wanted(entry.name) !== undefined });
  const entries: Entries = { images: [] };
  for (const [name, data] of Object.entries(files)) {
    if (wanted(name) === 'image') entries.images.push({ name, parts: [data] });
    else keepComicInfo(entries, name, [data]);
  }
  return entries;
}

async function sniff(file: Blob): Promise<'zip' | 'other'> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && [0x03, 0x05, 0x07].includes(head[2]) ? 'zip' : 'other';
}

/** Parses a CBZ/ZIP into ordered page blobs and ComicInfo metadata. CBR/RAR, 7z, and PDF are not supported. */
export async function parseComicArchive(file: Blob, fileName: string): Promise<ParsedArchive> {
  if (UNSUPPORTED_EXTENSIONS.test(fileName) || (await sniff(file)) !== 'zip') {
    throw new ProviderError('unsupported_format', `Unsupported archive: ${fileName}`);
  }
  let entries: Entries | undefined;
  try {
    entries = await readStreaming(file);
  } catch {
    entries = undefined;
  }
  if (!entries?.images.length) {
    try {
      entries = await readWhole(file);
    } catch (error) {
      throw new ProviderError('unsupported_format', `Could not read archive: ${fileName}`, { cause: error });
    }
  }
  if (!entries.images.length) throw new ProviderError('empty_archive', `No images in ${fileName}`);

  const pages = entries.images
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map(image => ({ name: image.name, blob: new Blob(image.parts as BlobPart[], { type: imageMimeType(image.name) }) }));
  const info = entries.comicInfo ? parseComicInfo(new TextDecoder().decode(await new Blob(entries.comicInfo.parts as BlobPart[]).arrayBuffer())) : {};
  return {
    title: info.title ?? titleFromFileName(fileName),
    ...(info.series ? { series: info.series } : {}),
    ...(info.volume ? { volume: info.volume } : {}),
    ...(info.number ? { number: info.number } : {}),
    ...(info.authors ? { authors: info.authors } : {}),
    ...(info.direction ? { direction: info.direction } : {}),
    ...(info.language ? { language: info.language } : {}),
    pages,
  };
}

/** Groups loose image files (e.g. a picked folder) into one chapter, in natural path order. */
export function parseImageFiles(files: File[], name: string): ParsedArchive {
  const path = (file: File) => file.webkitRelativePath || file.name;
  const pages = files
    .filter(file => !isIgnored(path(file)) && (imageMimeType(file.name) !== undefined || file.type.startsWith('image/')))
    .sort((a, b) => naturalCompare(path(a), path(b)))
    .map(file => {
      const type = imageMimeType(file.name) ?? file.type;
      // slice() relabels the type without copying the bytes.
      return { name: path(file), blob: file.type === type ? file : file.slice(0, file.size, type) };
    });
  if (!pages.length) throw new ProviderError('empty_archive', `No images in ${name}`);
  return { title: titleFromFileName(name), pages };
}
