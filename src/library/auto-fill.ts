import { createStore } from 'solid-js/store';
import { mangaKey, type MangaDetails, type MangaSummary, type SourceLink } from '../core/types';
import { getKv, setKv } from '../storage/db';
import { weebCentralProvider } from '../providers/weebcentral';
import { extraSourcesUnlocked } from '../providers/weebcentral/session';
import { library, settings } from './store';

/**
 * Automatic extra-source links. When a title opens, Weeb Central is searched
 * by its names and linked only on an exact (normalized) title match. These
 * links stay on this device; a link the user picks or stops by hand is stored
 * in the library entry and always wins.
 */

interface AutoLinkRecord {
  /** The matched series, or null when nothing matched. */
  link: SourceLink | null;
  at: number;
}

const KV_KEY = 'autofill.links';
/** Search again for titles that had no match after this long. */
export const RETRY_MISS_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUERIES = 2;

const [autoLinks, setAutoLinks] = createStore<Record<string, AutoLinkRecord>>({});
let loading: Promise<void> | undefined;
const pending = new Map<string, Promise<boolean>>();

export function loadAutoLinks(): Promise<void> {
  loading ??= getKv<Record<string, AutoLinkRecord>>(KV_KEY).then(saved => { if (saved) setAutoLinks(saved); });
  return loading;
}

async function saveAutoLink(key: string, record: AutoLinkRecord): Promise<void> {
  setAutoLinks(key, record);
  await setKv(KV_KEY, JSON.parse(JSON.stringify(autoLinks)));
}

/** Auto-fill is on unless the user turned it off in Settings. */
export function autoFillEnabled(): boolean {
  return settings.autoFill !== false;
}

/** The link that fills a title: the user's choice first, then an automatic match. */
export function effectiveSourceLink(key: string): (SourceLink & { auto?: boolean }) | undefined {
  const entry = library[key];
  const sources = entry && !entry.deleted ? entry.sources : undefined;
  if (sources?.weebcentral) return sources.weebcentral;
  if (sources?.declined || !autoFillEnabled()) return undefined;
  const auto = autoLinks[key]?.link;
  return auto ? { ...auto, auto: true } : undefined;
}

/** Lowercase, without accents, punctuation, or spacing, so "Kingdom!" equals "kingdom". */
export function normalizeTitle(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The first result whose title equals one of the title's names, after normalizing. */
export function matchTitle(names: string[], results: MangaSummary[]): MangaSummary | undefined {
  const wanted = new Set(names.map(normalizeTitle).filter(Boolean));
  return results.find(item => wanted.has(normalizeTitle(item.title)));
}

/** Names to search with: the title, then alternative names in Latin script. */
export function searchNames(details: Pick<MangaDetails, 'title' | 'altTitles'>): string[] {
  const names = [details.title, ...(details.altTitles ?? []).filter(name => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(name))];
  const seen = new Set<string>();
  return names.filter(name => {
    const normalized = normalizeTitle(name);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Try to link a title to Weeb Central automatically. Resolves true when a new
 * link was made (reload the chapter list). Never throws: auto-fill must not
 * block reading.
 */
export function autoLinkSource(details: MangaDetails, signal?: AbortSignal): Promise<boolean> {
  const key = mangaKey(details.provider, details.id);
  const running = pending.get(key);
  if (running) return running;
  const task = (async () => {
    if (details.provider === 'local' || !autoFillEnabled() || !extraSourcesUnlocked()) return false;
    await loadAutoLinks();
    const sources = library[key]?.deleted ? undefined : library[key]?.sources;
    if (sources?.weebcentral || sources?.declined) return false;
    const known = autoLinks[key];
    if (known?.link || (known && Date.now() - known.at < RETRY_MISS_AFTER_MS)) return false;
    const names = searchNames(details);
    for (const name of names.slice(0, MAX_QUERIES)) {
      const results = (await weebCentralProvider.search({ text: name }, signal)).items;
      const match = matchTitle(names, results);
      if (match) {
        await saveAutoLink(key, { link: { id: match.id, title: match.title }, at: Date.now() });
        return true;
      }
    }
    await saveAutoLink(key, { link: null, at: Date.now() });
    return false;
  })().catch(() => false).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
