/**
 * Pure mapping from MangaDex JSON to the shared domain types.
 */
import type { ChapterSummary, MangaDetails, MangaSummary, ReadingMode } from '../../core/types';
import type { ChapterEntity, LocalizedString, MangaEntity } from './api';
import { REMOVED_GROUP_IDS, mangaDexTitleUrl } from './policy';

export const LONG_STRIP_TAG = '3e2b8dae-350e-4ab8-a8ce-016e844b9f0d';
export const WEB_COMIC_TAG = 'e197df38-d0e7-43b5-9b09-2842d0c326dd';
const WEBTOON_LANGUAGES = new Set(['ko', 'zh', 'zh-hk']);

function entries(map: LocalizedString | undefined): Array<[string, string]> {
  return Object.entries(map ?? {}).filter(([, value]) => typeof value === 'string' && value.trim() !== '');
}

/** Every title variant, main title first, as [language, text]. */
function titleVariants(manga: MangaEntity): Array<[string, string]> {
  return [...entries(manga.attributes.title), ...(manga.attributes.altTitles ?? []).flatMap(entries)];
}

/**
 * Display title: English first, then the romanization of the original
 * language (`ja-ro`, `ko-ro`, …), then the main title, then anything.
 */
export function pickTitle(manga: MangaEntity): string {
  const variants = titleVariants(manga);
  const original = manga.attributes.originalLanguage;
  const find = (language: string) => variants.find(([lang]) => lang === language)?.[1];
  const romanized = original ? find(`${original.split('-')[0]}-ro`) : undefined;
  return (find('en') ?? romanized ?? entries(manga.attributes.title)[0]?.[1] ?? variants[0]?.[1] ?? 'Untitled').trim();
}

export function altTitles(manga: MangaEntity, chosen: string): string[] {
  const seen = new Set([chosen]);
  const result: string[] = [];
  for (const [, text] of titleVariants(manga)) {
    const value = text.trim();
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/**
 * MangaDex descriptions are Markdown with occasional BBCode and HTML. The UI
 * renders plain text, so reduce them to readable text: keep link labels,
 * drop images, emphasis markers, headings, rules, and tags.
 */
export function markdownToText(markdown: string): string {
  return decodeEntities(
    markdown
      .replace(/\r\n?/g, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
      .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
      .replace(/\[\/?(?:b|i|u|s|spoiler|url|img|quote|center|size(?:=[^\]]*)?|color(?:=[^\]]*)?)\]/gi, '')
      .replace(/^ {0,3}(?:[-*_] *){3,}$/gm, '')
      .replace(/^ {0,3}#{1,6}\s+/gm, '')
      .replace(/^ {0,3}>\s?/gm, '')
      .replace(/^(\s*)[*+]\s+/gm, '$1- ')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1'),
  )
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function pickDescription(manga: MangaEntity): string | undefined {
  const all = entries(manga.attributes.description);
  const chosen = all.find(([lang]) => lang === 'en')?.[1] ?? all[0]?.[1];
  const text = chosen ? markdownToText(chosen) : '';
  return text || undefined;
}

export function inferMode(manga: MangaEntity): ReadingMode {
  const tags = manga.attributes.tags ?? [];
  const has = (id: string, name: string) => tags.some(tag => tag.id === id || tag.attributes?.name?.en === name);
  const original = manga.attributes.originalLanguage ?? '';
  if (has(LONG_STRIP_TAG, 'Long Strip')) return 'vertical';
  if (has(WEB_COMIC_TAG, 'Web Comic') && WEBTOON_LANGUAGES.has(original)) return 'vertical';
  if (original === 'ja') return 'rtl';
  return 'ltr';
}

export function coverFileName(manga: MangaEntity): string | undefined {
  return manga.relationships.find(rel => rel.type === 'cover_art')?.attributes?.fileName;
}

function people(manga: MangaEntity): string[] {
  const names = manga.relationships
    .filter(rel => rel.type === 'author' || rel.type === 'artist')
    .map(rel => rel.attributes?.name?.trim())
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

const LINKS: Record<string, { label: string; url: (value: string) => string }> = {
  al: { label: 'AniList', url: v => `https://anilist.co/manga/${encodeURIComponent(v)}` },
  ap: { label: 'Anime-Planet', url: v => `https://www.anime-planet.com/manga/${encodeURIComponent(v)}` },
  bw: { label: 'BookWalker', url: v => `https://bookwalker.jp/${v.split('/').map(encodeURIComponent).join('/')}` },
  mu: { label: 'MangaUpdates', url: v => (/^\d+$/.test(v) ? `https://www.mangaupdates.com/series.html?id=${v}` : `https://www.mangaupdates.com/series/${encodeURIComponent(v)}`) },
  nu: { label: 'Novel Updates', url: v => `https://www.novelupdates.com/series/${encodeURIComponent(v)}` },
  kt: { label: 'Kitsu', url: v => `https://kitsu.app/manga/${encodeURIComponent(v)}` },
  mal: { label: 'MyAnimeList', url: v => `https://myanimelist.net/manga/${encodeURIComponent(v)}` },
  amz: { label: 'Amazon', url: v => v },
  ebj: { label: 'eBookJapan', url: v => v },
  cdj: { label: 'CDJapan', url: v => v },
  raw: { label: 'Official (original)', url: v => v },
  engtl: { label: 'Official (English)', url: v => v },
};

export function mapLinks(manga: MangaEntity): Array<{ label: string; url: string }> {
  const links = [{ label: 'MangaDex', url: mangaDexTitleUrl(manga.id) }];
  for (const [key, value] of Object.entries(manga.attributes.links ?? {})) {
    const known = LINKS[key];
    if (!known || typeof value !== 'string' || !value.trim()) continue;
    const url = known.url(value.trim());
    // Only http(s): never let a crafted value become a javascript: or data: link.
    if (/^https?:\/\//i.test(url)) links.push({ label: known.label, url });
  }
  return links;
}

export type CoverUrlBuilder = (mangaId: string, fileName: string) => string;

export function mapSummary(manga: MangaEntity, coverUrl: CoverUrlBuilder): MangaSummary {
  const a = manga.attributes;
  const fileName = coverFileName(manga);
  const authors = people(manga);
  const tags = (a.tags ?? []).map(tag => tag.attributes?.name?.en).filter((name): name is string => Boolean(name));
  const description = pickDescription(manga);
  return {
    provider: 'mangadex',
    id: manga.id,
    title: pickTitle(manga),
    ...(fileName ? { coverUrl: coverUrl(manga.id, `${fileName}.512.jpg`) } : {}),
    ...(description ? { description } : {}),
    ...(authors.length ? { authors } : {}),
    ...(a.status ? { status: a.status } : {}),
    ...(typeof a.year === 'number' ? { year: a.year } : {}),
    ...(a.originalLanguage ? { originalLanguage: a.originalLanguage } : {}),
    ...(a.contentRating ? { contentRating: a.contentRating } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

export function mapDetails(manga: MangaEntity, coverUrl: CoverUrlBuilder): MangaDetails {
  const summary = mapSummary(manga, coverUrl);
  const languages = [...new Set((manga.attributes.availableTranslatedLanguages ?? []).filter((lang): lang is string => Boolean(lang)))];
  return {
    ...summary,
    altTitles: altTitles(manga, summary.title),
    defaultMode: inferMode(manga),
    availableLanguages: languages,
    links: mapLinks(manga),
  };
}

/** Maps a chapter, or returns undefined when it cannot be read here and has no external link. */
export function mapChapter(chapter: ChapterEntity, mangaId?: string): ChapterSummary | undefined {
  const a = chapter.attributes;
  const groups = chapter.relationships.filter(rel => rel.type === 'scanlation_group');
  if (groups.some(group => REMOVED_GROUP_IDS.has(group.id))) return undefined;
  const externalUrl = a.externalUrl && /^https?:\/\//i.test(a.externalUrl) ? a.externalUrl : undefined;
  if (!(a.pages > 0) && !externalUrl) return undefined;
  const owner = mangaId ?? chapter.relationships.find(rel => rel.type === 'manga')?.id;
  if (!owner) return undefined;
  const groupNames = groups.map(group => group.attributes?.name?.trim()).filter((name): name is string => Boolean(name));
  const title = a.title?.trim();
  const publishedAt = a.readableAt ?? a.publishAt;
  return {
    provider: 'mangadex',
    mangaId: owner,
    id: chapter.id,
    ...(a.chapter?.trim() ? { number: a.chapter.trim() } : {}),
    ...(a.volume?.trim() ? { volume: a.volume.trim() } : {}),
    ...(title ? { title } : {}),
    language: a.translatedLanguage,
    pages: a.pages,
    ...(publishedAt ? { publishedAt } : {}),
    ...(groupNames.length ? { groups: groupNames } : {}),
    ...(externalUrl ? { externalUrl } : {}),
  };
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * Reading order: by chapter number ("2" < "10" < "10.5"), then volume.
 * Chapters without a number (oneshots, extras) go after the last numbered
 * chapter of their volume, or at the end when they have no volume either.
 * Releases of the same chapter by different groups stay together.
 */
export function sortChapters(chapters: ChapterSummary[]): ChapterSummary[] {
  const lastByVolume: Array<[number, number]> = [];
  for (const chapter of chapters) {
    const number = numeric(chapter.number);
    const volume = numeric(chapter.volume);
    if (number !== undefined && volume !== undefined) lastByVolume.push([volume, number]);
  }
  const position = (chapter: ChapterSummary): number => {
    const number = numeric(chapter.number);
    if (number !== undefined) return number;
    const volume = numeric(chapter.volume);
    if (volume === undefined) return Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const [v, n] of lastByVolume) if (v <= volume && n > last) last = n;
    return last;
  };
  const keyed = chapters.map(chapter => ({
    chapter,
    position: position(chapter),
    numbered: numeric(chapter.number) !== undefined ? 0 : 1,
    volume: numeric(chapter.volume) ?? Number.POSITIVE_INFINITY,
  }));
  keyed.sort((a, b) =>
    a.position - b.position ||
    a.numbered - b.numbered ||
    a.volume - b.volume ||
    (a.chapter.publishedAt ?? '').localeCompare(b.chapter.publishedAt ?? '') ||
    a.chapter.language.localeCompare(b.chapter.language) ||
    a.chapter.id.localeCompare(b.chapter.id),
  );
  return keyed.map(item => item.chapter);
}

/** MangaDex date filters take `YYYY-MM-DDTHH:mm:ss` in UTC, without milliseconds or zone. */
export function toMangaDexDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${iso}`);
  return date.toISOString().slice(0, 19);
}
