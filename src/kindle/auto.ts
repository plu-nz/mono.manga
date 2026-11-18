import type { ChapterSummary, KindleSendState, LibraryEntry, MangaDetails, ReadingProgress } from '../core/types';

/**
 * "Send new chapters": for each favorite, find the chapters published after
 * the last one delivered to the Kindle, one release per chapter number.
 */

export function chapterNumber(chapter: ChapterSummary): number | undefined {
  if (chapter.number === undefined || chapter.number === '') return undefined;
  const value = Number(chapter.number);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Where "new" starts for a title:
 * 1. the highest chapter number already sent;
 * 2. otherwise, the chapter the user is reading (chapters after it are new);
 * 3. otherwise, nothing — only the latest chapter is picked, to start the series.
 */
export function baselineNumber(chapters: ChapterSummary[], kindle?: KindleSendState, progress?: ReadingProgress): number | undefined {
  if (kindle?.lastNumber !== undefined) return kindle.lastNumber;
  if (progress && !progress.deleted) {
    const reading = chapters.find(chapter => chapter.id === progress.chapterId);
    const value = reading && chapterNumber(reading);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Choose one release per chapter number: preferred language first, then the last sent group, then most pages. */
function pickRelease(candidates: ChapterSummary[], languages: string[], groups?: string[]): ChapterSummary {
  const languageRank = (chapter: ChapterSummary) => {
    const index = languages.indexOf(chapter.language);
    return index < 0 ? languages.length : index;
  };
  const groupKey = (groups ?? []).join('|');
  return [...candidates].sort((a, b) =>
    languageRank(a) - languageRank(b)
    || Number((b.groups ?? []).join('|') === groupKey) - Number((a.groups ?? []).join('|') === groupKey)
    || b.pages - a.pages,
  )[0];
}

export function pickNewChapters(input: {
  chapters: ChapterSummary[];
  languages: string[];
  kindle?: KindleSendState;
  progress?: ReadingProgress;
}): ChapterSummary[] {
  const sent = new Set(input.kindle?.sentIds ?? []);
  const readable = input.chapters.filter(chapter => !chapter.externalUrl && chapter.pages > 0 && !sent.has(chapter.id));
  const byNumber = new Map<number, ChapterSummary[]>();
  for (const chapter of readable) {
    const value = chapterNumber(chapter);
    if (value === undefined) continue;
    if (!byNumber.has(value)) byNumber.set(value, []);
    byNumber.get(value)!.push(chapter);
  }
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  if (!numbers.length) return [];
  const baseline = baselineNumber(input.chapters, input.kindle, input.progress);
  const wanted = baseline === undefined ? numbers.slice(-1) : numbers.filter(value => value > baseline);
  return wanted.map(value => pickRelease(byNumber.get(value)!, input.languages, input.kindle?.lastGroups));
}

export interface TitleBatch {
  entry: LibraryEntry;
  details: MangaDetails;
  chapters: ChapterSummary[];
  /** True when nothing was sent before and no reading progress exists. */
  startsAtLatest: boolean;
}
