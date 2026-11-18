import type { MangaKey } from '../core/types';
import { db, type CachedManga } from './db';

export async function getCachedManga(key: MangaKey): Promise<CachedManga | undefined> {
  return (await db()).get('manga', key);
}

export async function putCachedManga(value: CachedManga): Promise<void> {
  await (await db()).put('manga', value);
}

export async function deleteCachedManga(key: MangaKey): Promise<void> {
  await (await db()).delete('manga', key);
}

export async function listCachedManga(): Promise<CachedManga[]> {
  return (await db()).getAll('manga');
}
