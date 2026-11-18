import type { MangaSummary } from '../../core/types';

/** Parsers for Weeb Central pages relayed as text by the Worker. */

export interface ParsedChapter {
  id: string;
  /** "893", "10.5"; absent when the label has no number. */
  number?: string;
  label: string;
  publishedAt?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };

function decode(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, name: string) => ENTITIES[name])
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function plainText(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function coverUrl(seriesId: string): string {
  return `https://temp.compsci88.com/cover/small/${seriesId}.webp`;
}

export function parseSearchResults(html: string): MangaSummary[] {
  const results: MangaSummary[] = [];
  const seen = new Set<string>();
  for (const block of html.split(/<article class="bg-base-300[^"]*"/).slice(1)) {
    const link = /href="https:\/\/weebcentral\.com\/series\/([0-9A-Z]{26})\/[^"]*"/.exec(block);
    if (!link || seen.has(link[1])) continue;
    const alt = /alt="([^"]+?) cover"/.exec(block);
    const title = alt ? decode(alt[1]) : undefined;
    if (!title) continue;
    seen.add(link[1]);
    const year = /<strong>Year:\s*<\/strong>\s*<span>(\d{4})<\/span>/.exec(block);
    results.push({ provider: 'weebcentral', id: link[1], title, coverUrl: coverUrl(link[1]), ...(year ? { year: Number(year[1]) } : {}) });
  }
  return results;
}

/** Chapters in reading order (the page lists newest first). */
export function parseChapterList(html: string): ParsedChapter[] {
  const chapters: ParsedChapter[] = [];
  const seen = new Set<string>();
  for (const block of html.split(/<div class="flex items-center" x-data=/).slice(1)) {
    const link = /href="(?:https:\/\/weebcentral\.com)?\/chapters\/([0-9A-Z]{26})"/.exec(block);
    if (!link || seen.has(link[1])) continue;
    seen.add(link[1]);
    const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const text = plainText((anchor?.[1] ?? block).replace(/<time[\s\S]*?<\/time>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, ''));
    const label = text.replace(/\s*Last Read\s*/g, ' ').trim();
    const number = /(?:Chapter|Episode|Ch\.)\s*(\d+(?:\.\d+)?)/i.exec(label)?.[1];
    const time = /<time[^>]*datetime="([^"]+)"/.exec(block)?.[1];
    chapters.push({ id: link[1], label, ...(number ? { number } : {}), ...(time ? { publishedAt: time } : {}) });
  }
  return chapters.reverse();
}
