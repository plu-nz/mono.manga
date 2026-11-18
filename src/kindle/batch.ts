import { mangaKey } from '../core/types';
import { loadManga } from '../library/manga';
import { effectiveMode, libraryEntries, markSentToKindle, progress, settings } from '../library/store';
import { sendFileByEmail, maxAttachmentBytes } from '../google';
import { DEFAULT_MAX_PART_BYTES } from '../converter';
import { baselineNumber, pickNewChapters, type TitleBatch } from './auto';
import { buildEpubs, downloadBlob, planExports, type BuildProgress } from './send';
import { t } from '../i18n';

/** Refresh every favorite and collect the chapters not yet delivered to the Kindle. */
export async function planNewChapters(options: {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
} = {}): Promise<{ batches: TitleBatch[]; failed: Array<{ title: string; error: unknown }> }> {
  const favorites = libraryEntries().filter(entry => entry.favorite);
  const batches: TitleBatch[] = [];
  const failed: Array<{ title: string; error: unknown }> = [];
  options.onProgress?.(0, favorites.length);
  // One title at a time keeps the MangaDex relay well inside its rate limits.
  for (const [index, entry] of favorites.entries()) {
    if (options.signal?.aborted) break;
    try {
      const { details, chapters } = await loadManga(entry.provider, entry.mangaId, options.signal);
      const current = progress[entry.key];
      const picked = pickNewChapters({ chapters, languages: [...settings.languages], kindle: entry.kindle, progress: current });
      if (picked.length) {
        batches.push({ entry, details, chapters: picked, startsAtLatest: baselineNumber(chapters, entry.kindle, current) === undefined });
      }
    } catch (error) {
      if (options.signal?.aborted) break;
      failed.push({ title: entry.title, error });
    }
    options.onProgress?.(index + 1, favorites.length);
  }
  return { batches, failed };
}

export type BatchStage =
  | { kind: 'converting'; progress: BuildProgress }
  | { kind: 'sending'; loaded: number; total: number; file: number; files: number };

/**
 * Convert one title's new chapters into EPUB parts and email them (marking
 * them as sent) or download them.
 */
export async function deliverBatch(batch: TitleBatch, target: 'email' | 'download', options: {
  signal?: AbortSignal;
  onStage?: (stage: BatchStage) => void;
}): Promise<number> {
  const plans = planExports(batch.details, batch.chapters, 'single');
  const parts = await buildEpubs({
    details: batch.details,
    plans,
    profileId: settings.kindleModel ?? '',
    mode: effectiveMode(mangaKey(batch.details.provider, batch.details.id), batch.details.defaultMode),
    dataSaver: settings.dataSaver,
    signal: options.signal,
    onProgress: progress => options.onStage?.({ kind: 'converting', progress }),
    maxPartBytes: target === 'email' ? Math.min(maxAttachmentBytes(), DEFAULT_MAX_PART_BYTES) : Number.POSITIVE_INFINITY,
  });
  if (target === 'download') {
    for (const part of parts) downloadBlob(part.blob, part.fileName);
    return parts.length;
  }
  for (const [index, part] of parts.entries()) {
    options.onStage?.({ kind: 'sending', loaded: 0, total: part.blob.size, file: index + 1, files: parts.length });
    await sendFileByEmail({
      to: settings.kindleEmail!,
      subject: part.title,
      text: t('Sent from PLUNZ Manga.'),
      file: part.blob,
      fileName: part.fileName,
      mimeType: 'application/epub+zip',
      signal: options.signal,
      onProgress: (loaded: number, total: number) => options.onStage?.({ kind: 'sending', loaded, total, file: index + 1, files: parts.length }),
    });
  }
  await markSentToKindle(batch.details, batch.chapters);
  return parts.length;
}
