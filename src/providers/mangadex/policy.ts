/**
 * Obligations from the MangaDex API Acceptable Usage Policy
 * (https://api.mangadex.org/docs/). See README.md in this directory.
 */
import type { ProviderAttribution } from '../../core/types';

/** "You MUST credit MangaDex." */
export const MANGADEX_ATTRIBUTION: ProviderAttribution = {
  text: 'Data and images from MangaDex',
  url: 'https://mangadex.org',
};

/** Link for "View on MangaDex". */
export function mangaDexTitleUrl(mangaId: string): string {
  return `https://mangadex.org/title/${encodeURIComponent(mangaId)}`;
}

export function mangaDexChapterUrl(chapterId: string): string {
  return `https://mangadex.org/chapter/${encodeURIComponent(chapterId)}`;
}

/**
 * Scanlation groups whose leaders asked, in writing, that their releases not
 * be shown in this app. The policy requires honoring such requests, including
 * from groups that do not upload to MangaDex. Add the group UUID with the date
 * and a reference to the request.
 */
export const REMOVED_GROUP_IDS: ReadonlySet<string> = new Set<string>([
  // 'uuid', // YYYY-MM-DD, request reference
]);
