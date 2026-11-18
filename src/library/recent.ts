import { createSignal } from 'solid-js';
import type { MangaDetails, ProviderId } from '../core/types';
import { getKv, setKv } from '../storage/db';

/**
 * Recent searches and recently opened titles. A per-device convenience kept
 * in IndexedDB only: never synchronized.
 */

export interface RecentTitle {
  provider: ProviderId;
  id: string;
  title: string;
  coverUrl?: string;
  openedAt: number;
}

const SEARCHES_KEY = 'recent.searches';
const TITLES_KEY = 'recent.titles';
const MAX_SEARCHES = 8;
const MAX_TITLES = 12;

const [recentSearches, setRecentSearches] = createSignal<string[]>([]);
const [recentTitles, setRecentTitles] = createSignal<RecentTitle[]>([]);
export { recentSearches, recentTitles };

let loading: Promise<void> | undefined;

export function loadRecent(): Promise<void> {
  loading ??= (async () => {
    setRecentSearches((await getKv<string[]>(SEARCHES_KEY)) ?? []);
    setRecentTitles((await getKv<RecentTitle[]>(TITLES_KEY)) ?? []);
  })();
  return loading;
}

/** Remember a query, most recent first, ignoring case differences. */
export async function addRecentSearch(query: string): Promise<void> {
  const text = query.trim();
  if (!text) return;
  await loadRecent();
  const next = [text, ...recentSearches().filter(item => item.toLowerCase() !== text.toLowerCase())].slice(0, MAX_SEARCHES);
  setRecentSearches(next);
  await setKv(SEARCHES_KEY, next);
}

export async function removeRecentSearch(query: string): Promise<void> {
  await loadRecent();
  const next = recentSearches().filter(item => item !== query);
  setRecentSearches(next);
  await setKv(SEARCHES_KEY, next);
}

export async function addRecentTitle(details: MangaDetails): Promise<void> {
  await loadRecent();
  const item: RecentTitle = { provider: details.provider, id: details.id, title: details.title, coverUrl: details.coverUrl, openedAt: Date.now() };
  const next = [item, ...recentTitles().filter(title => !(title.provider === item.provider && title.id === item.id))].slice(0, MAX_TITLES);
  setRecentTitles(next);
  await setKv(TITLES_KEY, next);
}

export async function clearRecent(): Promise<void> {
  setRecentSearches([]);
  setRecentTitles([]);
  await setKv(SEARCHES_KEY, []);
  await setKv(TITLES_KEY, []);
}
