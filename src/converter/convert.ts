/**
 * Conversion driver: pulls source pages one at a time, runs them through a
 * `PageProcessor`, and streams the results into one or more EPUB parts that
 * each stay under a byte budget. Independent of how images are processed, so
 * tests can drive it with pre-encoded JPEG bytes.
 */
import { EpubPartWriter, tocReserveBytes, type EpubTocEntry, type ProcessedImage } from './epub';
import { ConversionError, throwIfAborted } from './errors';
import type { ImageOptions } from './image';
import { bookIdentifier, epubFileName, partTitle, randomSeed } from './naming';
import type { PageProcessor } from './processor';
import { getKindleProfile } from '../kindle/profiles';

export interface EpubJob {
  /** e.g. "Berserk Vol. 2" */
  title: string;
  /** e.g. "Berserk" */
  series?: string;
  /** Volume number, written as the series `group-position`. */
  seriesIndex?: number;
  authors?: string[];
  /** BCP 47, e.g. `en`. */
  language: string;
  direction: 'ltr' | 'rtl';
  /** `KindleProfile` id; unknown ids fall back to the default profile. */
  profileId: string;
  /** Stable identifier seed; a random one is used when absent. */
  identifier?: string;
  /** `pageIndex` is in SOURCE page order (before spreads are split). */
  toc?: Array<{ title: string; pageIndex: number }>;
  /** Split landscape spreads into two portrait pages. Default true. */
  splitSpreads?: boolean;
  /** JPEG quality, 0..1. Default 0.75. */
  jpegQuality?: number;
  /** Maximum bytes per EPUB part. Default `DEFAULT_MAX_PART_BYTES`; `Infinity` disables splitting. */
  maxPartBytes?: number;
}

export interface EpubPart {
  blob: Blob;
  fileName: string;
  title: string;
  /** Zero-based, inclusive, in source page order. */
  firstSourcePage: number;
  lastSourcePage: number;
  /** Pages in this EPUB (after spread splitting). */
  pageCount: number;
}

export interface ConvertProgress {
  /** Source pages processed. */
  processed: number;
  total: number;
  /** EPUB bytes produced so far, across parts. */
  bytes: number;
  /** One-based part currently being written. */
  part: number;
}

export interface ConvertOptions {
  /** Number of source pages, for progress reporting. */
  total: number;
  onProgress?: (progress: ConvertProgress) => void;
  signal?: AbortSignal;
}

// E-ink panels hide JPEG artifacts well; 0.75 keeps screentone readable at roughly half the size of 0.85.
export const DEFAULT_JPEG_QUALITY = 0.75;
/**
 * Default part budget. Email attachments are base64-encoded (+33% plus line
 * breaks), so a 17 MiB EPUB becomes roughly 24.4 MB on the wire, which fits
 * Gmail's 25 MB message limit with room for headers.
 */
export const DEFAULT_MAX_PART_BYTES = 17 * 1024 * 1024;

/** First output page index of `sourceIndex`, given how many output pages each source page produced. */
export function outputPageIndex(pagesPerSource: readonly number[], sourceIndex: number): number {
  let index = 0;
  for (let i = 0; i < sourceIndex && i < pagesPerSource.length; i++) index += pagesPerSource[i];
  return index;
}

/**
 * TOC entries for the part covering source pages `firstSourcePage..lastSourcePage`,
 * with indices mapped to the part's output pages. When the part starts in the
 * middle of a chapter, that chapter is listed at the part's first page.
 */
export function tocForPart(
  toc: ReadonlyArray<{ title: string; pageIndex: number }>,
  range: { firstSourcePage: number; lastSourcePage: number },
  outputIndexOf: (sourceIndex: number) => number,
): EpubTocEntry[] {
  const inside = toc.filter((entry) => entry.pageIndex >= range.firstSourcePage && entry.pageIndex <= range.lastSourcePage);
  const result = inside.map((entry) => ({ title: entry.title, pageIndex: outputIndexOf(entry.pageIndex) }));
  if (!inside.some((entry) => entry.pageIndex === range.firstSourcePage)) {
    let carried: { title: string; pageIndex: number } | undefined;
    for (const entry of toc) {
      if (entry.pageIndex < range.firstSourcePage && (!carried || entry.pageIndex >= carried.pageIndex)) carried = entry;
    }
    if (carried) result.unshift({ title: carried.title, pageIndex: 0 });
  }
  return result;
}

interface OpenPart {
  writer: EpubPartWriter;
  firstSourcePage: number;
  lastSourcePage: number;
  firstOutput: Map<number, number>;
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ConversionError('aborted', 'Conversion was cancelled.'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function pageIterator(pages: AsyncIterable<Blob> | Iterable<Blob>): AsyncIterator<Blob> | Iterator<Blob> {
  if (Symbol.asyncIterator in pages) return (pages as AsyncIterable<Blob>)[Symbol.asyncIterator]();
  return (pages as Iterable<Blob>)[Symbol.iterator]();
}

function validate(job: EpubJob): { quality: number; maxPartBytes: number } {
  const quality = job.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  if (!(quality > 0 && quality <= 1)) throw new ConversionError('invalid_job', 'jpegQuality must be in (0, 1].');
  const maxPartBytes = job.maxPartBytes ?? DEFAULT_MAX_PART_BYTES;
  if (!(maxPartBytes > 0)) throw new ConversionError('invalid_job', 'maxPartBytes must be positive.');
  if (job.direction !== 'ltr' && job.direction !== 'rtl') throw new ConversionError('invalid_job', 'direction must be ltr or rtl.');
  return { quality, maxPartBytes };
}

/**
 * Converts pages with the given processor, which this function owns: it is
 * disposed when conversion ends, fails, or is aborted.
 */
export async function convertWithProcessor(
  job: EpubJob,
  pages: AsyncIterable<Blob> | Iterable<Blob>,
  options: ConvertOptions,
  processor: PageProcessor,
  env: { now?: Date } = {},
): Promise<EpubPart[]> {
  const { signal } = options;
  const onAbort = () => processor.dispose();
  signal?.addEventListener('abort', onAbort, { once: true });
  let iterator: AsyncIterator<Blob> | Iterator<Blob> | undefined;
  let exhausted = false;
  try {
    throwIfAborted(signal);
    const { quality, maxPartBytes } = validate(job);
    const profile = getKindleProfile(job.profileId);
    const title = job.title.trim() || 'Manga';
    const seed = job.identifier?.trim() || randomSeed();
    const modified = env.now ?? new Date();
    const toc = (job.toc ?? []).filter((entry) => Number.isInteger(entry.pageIndex) && entry.pageIndex >= 0);
    const tocReserve = tocReserveBytes(toc);
    const imageOptions: ImageOptions = {
      maxWidth: profile.width,
      maxHeight: profile.height,
      grayscale: !profile.color,
      splitSpreads: job.splitSpreads ?? true,
      direction: job.direction,
      quality,
    };

    const finished: EpubPart[] = [];
    let finishedBytes = 0;
    let current: OpenPart | undefined;

    const finalize = (part: OpenPart, number: number | undefined): EpubPart => {
      const partName = partTitle(title, number);
      const blob = part.writer.finish({
        title: partName,
        authors: (job.authors ?? []).map((author) => author.trim()).filter(Boolean),
        language: job.language,
        direction: job.direction,
        identifier: bookIdentifier(seed, number),
        series: job.series?.trim() || undefined,
        seriesIndex: job.seriesIndex,
        modified,
        originalResolution: { width: profile.width, height: profile.height },
        toc: tocForPart(toc, part, (source) => part.firstOutput.get(source) ?? 0),
      });
      return {
        blob,
        fileName: epubFileName(title, number),
        title: partName,
        firstSourcePage: part.firstSourcePage,
        lastSourcePage: part.lastSourcePage,
        pageCount: part.writer.pageCount,
      };
    };

    iterator = pageIterator(pages);
    let sourceIndex = 0;
    for (;;) {
      throwIfAborted(signal);
      const step = await withAbort(Promise.resolve(iterator.next()), signal);
      if (step.done) {
        exhausted = true;
        break;
      }
      const images: ProcessedImage[] = await withAbort(processor.process(step.value, imageOptions, sourceIndex), signal);
      throwIfAborted(signal);
      if (images.length > 0) {
        if (current && current.writer.pageCount > 0 && current.writer.projectedSize(images) > maxPartBytes) {
          const part = finalize(current, finished.length + 1);
          finished.push(part);
          finishedBytes += part.blob.size;
          current = undefined;
        }
        if (!current) {
          current = {
            writer: new EpubPartWriter({ language: job.language, modified, tocReserve }),
            firstSourcePage: sourceIndex,
            lastSourcePage: sourceIndex,
            firstOutput: new Map(),
          };
        }
        current.firstOutput.set(sourceIndex, current.writer.pageCount);
        for (const image of images) current.writer.addPage(image);
        current.lastSourcePage = sourceIndex;
      }
      sourceIndex++;
      options.onProgress?.({
        processed: sourceIndex,
        total: Math.max(options.total, sourceIndex),
        bytes: finishedBytes + (current?.writer.bytesWritten ?? 0),
        part: finished.length + 1,
      });
    }

    if (!current) {
      if (finished.length === 0) throw new ConversionError('no_pages', 'There are no pages to convert.');
      return finished;
    }
    finished.push(finalize(current, finished.length > 0 ? finished.length + 1 : undefined));
    return finished;
  } catch (error) {
    if (signal?.aborted) throw new ConversionError('aborted', 'Conversion was cancelled.', { cause: error });
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    processor.dispose();
    if (iterator && !exhausted) {
      // Let generators release their resources (e.g. stop fetching pages).
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
}
