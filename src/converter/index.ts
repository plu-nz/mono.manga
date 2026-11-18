/**
 * Public API of the converter: turns manga pages into Kindle-ready
 * fixed-layout EPUB 3 files, entirely in the browser.
 */
import { convertWithProcessor, type ConvertOptions, type EpubJob, type EpubPart } from './convert';
import { createPageProcessor } from './processor';

export type { ConvertOptions, ConvertProgress, EpubJob, EpubPart } from './convert';
export { DEFAULT_JPEG_QUALITY, DEFAULT_MAX_PART_BYTES } from './convert';
export { ConversionError, isConversionError, type ConversionErrorCode } from './errors';
export { epubFileName } from './naming';
export { DEFAULT_KINDLE_PROFILE_ID, KINDLE_PROFILES, getKindleProfile, type KindleProfile } from '../kindle/profiles';

/**
 * Converts page images (in reading order) into one or more EPUB parts.
 * Pages are pulled one at a time and processed in a Web Worker when possible
 * (main-thread canvas otherwise). Rejects with `ConversionError`.
 */
export async function convertToEpub(
  job: EpubJob,
  pages: AsyncIterable<Blob> | Iterable<Blob>,
  options: ConvertOptions,
): Promise<EpubPart[]> {
  const processor = await createPageProcessor();
  return convertWithProcessor(job, pages, options, processor);
}
