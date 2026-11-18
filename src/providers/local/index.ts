import { mangaKey, type ChapterSummary, type MangaDetails, type MangaProvider, type PageRef } from '../../core/types';
import { getCachedManga, putCachedManga } from '../../storage/manga-cache';
import { listDownloads, listDownloadsForManga, storeImportedChapter } from '../../storage/downloads';
import { parseComicArchive, parseImageFiles, type ParsedArchive } from './archive';

/**
 * Titles imported from the user's own files (CBZ/ZIP or loose images).
 * Pages live in IndexedDB like offline chapters; nothing leaves the device.
 */

/** Cover URLs of imported titles point at their first stored page. */
export const LOCAL_COVER_PREFIX = 'local-cover:';

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
}

function compareChapters(a: ChapterSummary, b: ChapterSummary): number {
  const num = (value?: string) => (value === undefined || value === '' || Number.isNaN(Number(value)) ? Number.POSITIVE_INFINITY : Number(value));
  return num(a.volume) - num(b.volume) || num(a.number) - num(b.number) || (a.title ?? '').localeCompare(b.title ?? '', undefined, { numeric: true });
}

export const localProvider: MangaProvider = {
  id: 'local',
  name: 'Your files',
  capabilities: { search: false, updates: false },
  async search() {
    return { items: [], total: 0, offset: 0, limit: 0 };
  },
  async getManga(id) {
    const cached = await getCachedManga(mangaKey('local', id));
    if (!cached) throw Object.assign(new Error('Imported title not found'), { code: 'not_found' });
    return cached.details;
  },
  async getChapters(mangaId) {
    const cached = await getCachedManga(mangaKey('local', mangaId));
    return cached?.chapters ?? [];
  },
  async getPages(chapterId) {
    // Pages are always stored locally; the reader loads them from IndexedDB by index.
    const all = await listAllLocalChapters();
    const chapter = all.find(item => item.id === chapterId);
    return Array.from({ length: chapter?.pages ?? 0 }, (_, index): PageRef => ({ index, url: '' }));
  },
};

async function listAllLocalChapters(): Promise<ChapterSummary[]> {
  return (await listDownloads()).filter(record => record.chapter.provider === 'local').map(record => record.chapter);
}

export interface ImportResult {
  details: MangaDetails;
  chapters: number;
  pages: number;
}

async function storeParsed(parsed: ParsedArchive): Promise<ImportResult> {
  const series = parsed.series || parsed.title;
  const id = slug(series);
  const key = mangaKey('local', id);
  const cached = await getCachedManga(key);
  const chapter: ChapterSummary = {
    provider: 'local',
    mangaId: id,
    id: `${id}-${crypto.randomUUID()}`,
    number: parsed.number,
    volume: parsed.volume,
    title: parsed.series && parsed.title !== parsed.series ? parsed.title : parsed.number || parsed.volume ? undefined : parsed.title,
    language: parsed.language ?? 'en',
    pages: parsed.pages.length,
  };
  const details: MangaDetails = cached?.details ?? {
    provider: 'local',
    id,
    title: series,
    authors: parsed.authors,
    coverUrl: `${LOCAL_COVER_PREFIX}${chapter.id}`,
    defaultMode: parsed.direction === 'rtl' ? 'rtl' : 'ltr',
    originalLanguage: parsed.direction === 'rtl' ? 'ja' : undefined,
  };
  await storeImportedChapter({ mangaKey: key, mangaTitle: details.title, chapter, pages: parsed.pages.map(page => page.blob) });
  const chapters = [...(cached?.chapters ?? []), chapter].sort(compareChapters);
  await putCachedManga({ key, details, chapters, languages: [], fetchedAt: Date.now() });
  return { details, chapters: 1, pages: parsed.pages.length };
}

/**
 * Import CBZ/ZIP archives (one chapter or volume each) and loose images
 * (grouped into a single chapter named after the first file).
 */
export async function importLocalFiles(files: File[]): Promise<ImportResult[]> {
  const archives = files.filter(file => /\.(cbz|zip)$/i.test(file.name) || file.type === 'application/zip');
  const images = files.filter(file => !archives.includes(file) && (file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)$/i.test(file.name)));
  const unsupported = files.filter(file => !archives.includes(file) && !images.includes(file));
  if (unsupported.length && !archives.length && !images.length) {
    throw Object.assign(new Error('Unsupported file type'), { code: 'unsupported_format' });
  }
  const results: ImportResult[] = [];
  for (const archive of archives) results.push(await storeParsed(await parseComicArchive(archive, archive.name)));
  if (images.length) {
    const name = images[0].webkitRelativePath?.split('/')[0] || images[0].name.replace(/\.[^.]+$/, '');
    results.push(await storeParsed(parseImageFiles(images, name)));
  }
  return results;
}

export async function localChapterCount(id: string): Promise<number> {
  return (await listDownloadsForManga(mangaKey('local', id))).length;
}
