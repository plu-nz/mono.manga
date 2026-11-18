import { chapterLabel, type ChapterSummary, type MangaDetails, type ReadingMode } from '../core/types';
import { convertToEpub, type ConvertProgress, type EpubPart } from '../converter';
import { loadChapterPages } from '../reader/pages';

/**
 * Turns selected chapters into Kindle EPUBs: plan the files, stream every
 * page into the converter one at a time, and hand the parts back for
 * emailing or download.
 */

export type Grouping = 'single' | 'volume' | 'chapter';

export interface ExportPlan {
  title: string;
  seriesIndex?: number;
  chapters: ChapterSummary[];
}

function rangeLabel(chapters: ChapterSummary[]): string {
  if (chapters.length === 1) return chapterLabel({ ...chapters[0], title: chapters[0].title });
  const first = chapters[0];
  const last = chapters[chapters.length - 1];
  if (first.volume && first.volume === last.volume) return `Vol. ${first.volume}`;
  if (first.number && last.number) return `Ch. ${first.number}–${last.number}`;
  return `${chapterLabel({ ...first, title: undefined })} – ${chapterLabel({ ...last, title: undefined })}`;
}

export function planExports(details: MangaDetails, chapters: ChapterSummary[], grouping: Grouping): ExportPlan[] {
  const readable = chapters.filter(chapter => !chapter.externalUrl);
  if (!readable.length) return [];
  if (grouping === 'chapter') {
    return readable.map(chapter => ({ title: `${details.title} ${rangeLabel([chapter])}`, chapters: [chapter] }));
  }
  if (grouping === 'volume') {
    const groups = new Map<string, ChapterSummary[]>();
    for (const chapter of readable) {
      const volume = chapter.volume ?? '';
      if (!groups.has(volume)) groups.set(volume, []);
      groups.get(volume)!.push(chapter);
    }
    return [...groups.entries()].map(([volume, items]) => ({
      title: volume ? `${details.title} Vol. ${volume}` : `${details.title} ${rangeLabel(items)}`,
      seriesIndex: volume && !Number.isNaN(Number(volume)) ? Number(volume) : undefined,
      chapters: items,
    }));
  }
  const volumes = new Set(readable.map(chapter => chapter.volume));
  const onlyVolume = volumes.size === 1 ? readable[0].volume : undefined;
  return [{
    title: `${details.title} ${rangeLabel(readable)}`,
    seriesIndex: onlyVolume && !Number.isNaN(Number(onlyVolume)) ? Number(onlyVolume) : undefined,
    chapters: readable,
  }];
}

export interface BuildProgress extends ConvertProgress {
  file: number;
  files: number;
}

export async function buildEpubs(input: {
  details: MangaDetails;
  plans: ExportPlan[];
  profileId: string;
  mode: ReadingMode;
  dataSaver: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: BuildProgress) => void;
  maxPartBytes?: number;
}): Promise<EpubPart[]> {
  const output: EpubPart[] = [];
  for (const [fileIndex, plan] of input.plans.entries()) {
    const toc: Array<{ title: string; pageIndex: number }> = [];
    let offset = 0;
    for (const chapter of plan.chapters) {
      toc.push({ title: chapterLabel(chapter), pageIndex: offset });
      offset += chapter.pages;
    }
    const total = offset;
    const signal = input.signal;
    async function* pages(): AsyncGenerator<Blob> {
      for (const chapter of plan.chapters) {
        const handles = await loadChapterPages(chapter, { dataSaver: input.dataSaver, signal });
        yield* prefetched(handles, signal);
      }
    }
    const parts = await convertToEpub(
      {
        title: plan.title,
        series: input.details.title,
        seriesIndex: plan.seriesIndex,
        authors: input.details.authors,
        language: plan.chapters[0]?.language ?? 'en',
        direction: input.mode === 'rtl' ? 'rtl' : 'ltr',
        profileId: input.profileId,
        identifier: `plunz-manga:${input.details.provider}:${input.details.id}:${plan.chapters.map(chapter => chapter.id).join(',')}`,
        toc,
        maxPartBytes: input.maxPartBytes,
      },
      pages(),
      { total, signal, onProgress: progress => input.onProgress?.({ ...progress, file: fileIndex + 1, files: input.plans.length }) },
    );
    output.push(...parts);
  }
  return output;
}

/** Pages fetched ahead while the converter works on the current one. */
const PREFETCH = 4;

/**
 * Yield page blobs in order while keeping a few downloads in flight, so
 * network latency overlaps with image processing. Memory stays bounded to
 * PREFETCH pages.
 */
export async function* prefetched(handles: Array<{ blob(signal?: AbortSignal): Promise<Blob> }>, signal?: AbortSignal): AsyncGenerator<Blob> {
  const inFlight: Array<Promise<Blob>> = [];
  let next = 0;
  const fill = () => {
    while (inFlight.length < PREFETCH && next < handles.length) {
      const request = handles[next++].blob(signal);
      // Avoid unhandled rejections for requests abandoned after an earlier failure.
      request.catch(() => undefined);
      inFlight.push(request);
    }
  };
  fill();
  while (inFlight.length) {
    const blob = await inFlight.shift()!;
    fill();
    yield blob;
  }
}

/** Save a generated file through the browser's download flow. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function isKindleAddress(value: string): boolean {
  return /^[^\s@]+@(free\.)?kindle\.(com|cn)$/i.test(value.trim());
}
