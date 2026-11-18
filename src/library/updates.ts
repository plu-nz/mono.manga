import { createSignal } from 'solid-js';
import { parseMangaKey } from '../core/types';
import { getProvider } from '../providers';
import { db, getKv, setKv, type UpdateItem } from '../storage/db';
import { libraryEntries, settings } from './store';

/**
 * New-chapter tracking without a server: when the app is opened (at most
 * every few hours) ask each provider for chapters published since the last
 * check for the titles in the library.
 */

const LAST_CHECK_KEY = 'updates.lastCheck';
const MIN_INTERVAL = 3 * 60 * 60 * 1000;
const FIRST_LOOKBACK = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 300;

const [updates, setUpdates] = createSignal<UpdateItem[]>([]);
const [checking, setChecking] = createSignal(false);
export { updates, checking };

export const unseenCount = () => updates().filter(item => !item.seen).length;

export async function loadUpdates(): Promise<void> {
  const all = await (await db()).getAllFromIndex('updates', 'byFoundAt');
  setUpdates(all.reverse());
}

/** Format accepted by MangaDex: YYYY-MM-DDTHH:mm:ss (UTC, no milliseconds). */
function isoSeconds(time: number): string {
  return new Date(time).toISOString().slice(0, 19);
}

export async function checkForUpdates(options: { force?: boolean } = {}): Promise<number> {
  if (checking()) return 0;
  const now = Date.now();
  const last = (await getKv<number>(LAST_CHECK_KEY)) ?? now - FIRST_LOOKBACK;
  if (!options.force && now - last < MIN_INTERVAL) return 0;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;
  setChecking(true);
  try {
    const byProvider = new Map<string, Map<string, string>>();
    for (const entry of libraryEntries()) {
      const { provider, id } = parseMangaKey(entry.key);
      if (!byProvider.has(provider)) byProvider.set(provider, new Map());
      byProvider.get(provider)!.set(id, entry.title);
    }
    const database = await db();
    let found = 0;
    for (const [providerId, titles] of byProvider) {
      const provider = getProvider(providerId as never);
      if (!provider.capabilities.updates || !provider.getUpdates || titles.size === 0) continue;
      const chapters = await provider.getUpdates([...titles.keys()], { languages: [...settings.languages], since: isoSeconds(last) });
      for (const chapter of chapters) {
        if (await database.get('updates', chapter.id)) continue;
        await database.put('updates', {
          chapter,
          mangaKey: `${chapter.provider}:${chapter.mangaId}`,
          mangaTitle: titles.get(chapter.mangaId) ?? '',
          foundAt: now,
          seen: false,
        });
        found += 1;
      }
    }
    await setKv(LAST_CHECK_KEY, now);
    await pruneUpdates();
    await loadUpdates();
    return found;
  } finally {
    setChecking(false);
  }
}

async function pruneUpdates(): Promise<void> {
  const database = await db();
  const all = await database.getAllFromIndex('updates', 'byFoundAt');
  const excess = all.length - MAX_ITEMS;
  for (const item of all.slice(0, Math.max(0, excess))) await database.delete('updates', item.chapter.id);
}

export async function markUpdatesSeen(predicate: (item: UpdateItem) => boolean = () => true): Promise<void> {
  const database = await db();
  for (const item of updates()) {
    if (!item.seen && predicate(item)) await database.put('updates', { ...item, seen: true });
  }
  await loadUpdates();
}
