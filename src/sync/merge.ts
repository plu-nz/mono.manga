/**
 * Pure per-key merge of two record maps (local device vs. remote document).
 *
 * Rules:
 * - Last write wins on `updatedAt`, per key.
 * - Tie (equal `updatedAt`): the remote value wins. Every device then
 *   converges on whatever reached the remote first, deterministically.
 * - Tombstones (`deleted: true`) are ordinary writes and win the same way.
 * - Tombstones older than `TOMBSTONE_TTL_MS` (90 days) are pruned from the
 *   merged result. Devices offline longer than that may resurrect a deleted
 *   record; this is the usual trade-off for bounded storage.
 * - Records without a finite numeric `updatedAt` are ignored as corrupt.
 * - A collection may pass `combine` to merge two live (non-deleted) versions
 *   field by field instead of picking one (used for reading progress).
 */
import type { SyncRecord } from '../core/types';

export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface MergeResult<T extends SyncRecord> {
  merged: Record<string, T>;
  /** Keys whose local value must be replaced by `merged[key]`. */
  localChanged: string[];
  /** True when the remote document differs from `merged` and must be rewritten. */
  remoteChanged: boolean;
}

function isValidRecord(value: unknown): value is SyncRecord {
  return typeof value === 'object' && value !== null && Number.isFinite((value as SyncRecord).updatedAt);
}

/** Structural equality for JSON-like values (key order independent). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  const aKeys = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
  const bKeys = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function mergeRecords<T extends SyncRecord>(
  local: Record<string, T>,
  remote: Record<string, T>,
  now: number,
  combine?: (local: T, remote: T) => T,
): MergeResult<T> {
  const merged: Record<string, T> = {};
  const localChanged: string[] = [];
  let remoteChanged = false;
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const key of keys) {
    const l = isValidRecord(local[key]) ? local[key] : undefined;
    const r = isValidRecord(remote[key]) ? remote[key] : undefined;
    // A corrupt remote entry must be rewritten (or dropped).
    if (remote[key] !== undefined && !r) remoteChanged = true;

    let winner: T | undefined;
    if (l && r) winner = combine && !l.deleted && !r.deleted ? combine(l, r) : l.updatedAt > r.updatedAt ? l : r;
    else winner = l ?? r;
    if (!winner) continue;

    if (winner.deleted && now - winner.updatedAt > TOMBSTONE_TTL_MS) {
      // Pruned: the remote document must drop it if it still has it.
      if (r) remoteChanged = true;
      continue;
    }

    merged[key] = winner;
    if (winner !== l && !(l && jsonEqual(l, winner))) localChanged.push(key);
    if (winner !== r && !(r && jsonEqual(r, winner))) remoteChanged = true;
  }

  return { merged, localChanged, remoteChanged };
}
