import type { ChapterSummary } from '../core/types';
import { chapterNumber } from '../kindle/auto';

/**
 * Add chapters from an extra source for every chapter number the title's own
 * provider cannot serve (missing, or only an external link). Releases the
 * provider has are always kept; the result stays in reading order.
 */
export function fillChapters(primary: ChapterSummary[], extra: ChapterSummary[]): ChapterSummary[] {
  if (!extra.length) return primary;
  const readable = new Set<number>();
  for (const chapter of primary) {
    const value = chapterNumber(chapter);
    if (value !== undefined && !chapter.externalUrl && chapter.pages > 0) readable.add(value);
  }
  const fill = new Map<number, ChapterSummary>();
  for (const chapter of extra) {
    const value = chapterNumber(chapter);
    if (value !== undefined && !readable.has(value) && !fill.has(value)) fill.set(value, chapter);
  }
  if (!fill.size) return primary;

  // External-only releases of a filled number would just duplicate it.
  const kept = primary.filter(chapter => {
    const value = chapterNumber(chapter);
    return !(chapter.externalUrl && value !== undefined && fill.has(value));
  });
  // Unnumbered chapters (oneshots, extras) sort right after the chapter before them.
  let last = -Infinity;
  const keyed = kept.map((chapter, index) => {
    const value = chapterNumber(chapter);
    if (value !== undefined) last = value;
    return { chapter, key: value ?? last, order: index };
  });
  for (const [value, chapter] of fill) keyed.push({ chapter, key: value, order: Number.MAX_SAFE_INTEGER });
  return keyed.sort((a, b) => a.key - b.key || a.order - b.order).map(item => item.chapter);
}
