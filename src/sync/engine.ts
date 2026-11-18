/**
 * Synchronizes local collections with one JSON document per collection in
 * Drive appData (`${collection}.json` = `{ version: 1, updatedAt, records }`).
 *
 * A run, per collection: read remote → merge with local (see merge.ts) →
 * apply local changes → write remote only if it changed.
 *
 * Drive has no compare-and-swap, so two devices writing at the same moment
 * can overwrite each other's document. Nothing is lost: each device keeps its
 * records locally and the next sync re-pushes anything missing remotely.
 */
import { mergeProgress, type ReadingProgress, type SyncRecord } from '../core/types';
import { GoogleError } from '../google/errors';
import type { DriveStore } from '../google/drive';
import { mergeRecords } from './merge';

export type Collection = 'library' | 'progress' | 'settings';

export const ALL_COLLECTIONS: readonly Collection[] = ['library', 'progress', 'settings'];
export const REMOTE_VERSION = 1;

export interface LocalSyncStore {
  read(collection: Collection): Promise<Record<string, SyncRecord>>;
  /** Upsert these records (tombstones included). */
  apply(collection: Collection, records: Record<string, SyncRecord>): Promise<void>;
}

export interface SyncReport {
  /** Local records replaced by remote values. */
  pulled: number;
  /** Whether the remote document was rewritten. */
  pushed: boolean;
  at: number;
}

export interface RemoteDocument {
  version: number;
  updatedAt: number;
  records: Record<string, SyncRecord>;
}

export interface SyncEngine {
  /**
   * Runs one sync of every collection. Only one run is in flight; calls made
   * during a run share a single follow-up run started after it. Collections
   * are processed in order; if any fails the others still run and the first
   * error is thrown afterwards.
   */
  sync(): Promise<Record<Collection, SyncReport>>;
}

export function remoteFileName(collection: Collection): string {
  return `${collection}.json`;
}

function parseRemote(collection: Collection, data: unknown): Record<string, SyncRecord> {
  const doc = data as Partial<RemoteDocument> | null;
  if (!doc || typeof doc !== 'object' || doc.version !== REMOTE_VERSION || !doc.records || typeof doc.records !== 'object') {
    const version = doc && typeof doc === 'object' ? doc.version : undefined;
    throw new GoogleError(
      'api',
      `Synced ${remoteFileName(collection)} has unsupported format (version ${String(version)}); ` +
        'it was written by a newer or incompatible app version and was left untouched. Update the app to sync.',
    );
  }
  return doc.records;
}

export function createSyncEngine(options: {
  local: LocalSyncStore;
  remote: DriveStore;
  collections?: Collection[];
  now?: () => number;
}): SyncEngine {
  const collections = options.collections ?? [...ALL_COLLECTIONS];
  const now = options.now ?? Date.now;

  async function syncCollection(collection: Collection): Promise<SyncReport> {
    const name = remoteFileName(collection);
    const remoteFile = await options.remote.read<unknown>(name);
    const remoteRecords = remoteFile ? parseRemote(collection, remoteFile.data) : {};
    const localRecords = await options.local.read(collection);
    const combine = collection === 'progress'
      ? (l: SyncRecord, r: SyncRecord) => mergeProgress(l as ReadingProgress, r as ReadingProgress) as SyncRecord
      : undefined;
    const { merged, localChanged, remoteChanged } = mergeRecords(localRecords, remoteRecords, now(), combine);

    if (localChanged.length) {
      const changes: Record<string, SyncRecord> = {};
      for (const key of localChanged) changes[key] = merged[key];
      await options.local.apply(collection, changes);
    }

    const pushed = remoteChanged && (remoteFile !== null || Object.keys(merged).length > 0);
    if (pushed) {
      const doc: RemoteDocument = { version: REMOTE_VERSION, updatedAt: now(), records: merged };
      await options.remote.write(name, doc, remoteFile?.id);
    }
    return { pulled: localChanged.length, pushed, at: now() };
  }

  async function run(): Promise<Record<Collection, SyncReport>> {
    const reports = {} as Record<Collection, SyncReport>;
    let firstError: unknown;
    for (const collection of collections) {
      try {
        reports[collection] = await syncCollection(collection);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
    return reports;
  }

  let running: Promise<Record<Collection, SyncReport>> | null = null;
  let queued: Promise<Record<Collection, SyncReport>> | null = null;

  function sync(): Promise<Record<Collection, SyncReport>> {
    if (!running) {
      running = run().finally(() => {
        running = null;
      });
      return running;
    }
    if (!queued) {
      queued = running
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return sync();
        });
    }
    return queued;
  }

  return { sync };
}

export interface SyncSchedulerOptions {
  /** Delay after the last `schedule()` before syncing. Default 5000 ms. */
  debounceMs?: number;
  onError?: (error: unknown) => void;
  onReport?: (report: Record<Collection, SyncReport>) => void;
}

export interface SyncScheduler {
  /** Debounced sync, e.g. after each local write. */
  schedule(): void;
  /** Sync immediately (cancels a pending debounce). Resolves with the report, or undefined on error/offline. */
  now(): Promise<Record<Collection, SyncReport> | undefined>;
  /** Syncs when the page becomes visible and when the browser comes back online. Returns a detach function. */
  attachAutoTriggers(target?: { window?: Window; document?: Document }): () => void;
  /** Cancels pending work and detaches triggers. */
  dispose(): void;
}

export function createSyncScheduler(engine: SyncEngine, options: SyncSchedulerOptions = {}): SyncScheduler {
  const debounceMs = options.debounceMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const detachers = new Set<() => void>();
  let disposed = false;

  const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

  async function now(): Promise<Record<Collection, SyncReport> | undefined> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // The `online` trigger retries once connectivity returns.
    if (disposed || isOffline()) return undefined;
    try {
      const report = await engine.sync();
      options.onReport?.(report);
      return report;
    } catch (error) {
      options.onError?.(error);
      return undefined;
    }
  }

  function schedule(): void {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void now();
    }, debounceMs);
  }

  function attachAutoTriggers(target: { window?: Window; document?: Document } = {}): () => void {
    const win = target.window ?? (typeof window !== 'undefined' ? window : undefined);
    const doc = target.document ?? (typeof document !== 'undefined' ? document : undefined);
    const onVisible = (): void => {
      if (doc?.visibilityState === 'visible') void now();
    };
    const onOnline = (): void => void now();
    doc?.addEventListener('visibilitychange', onVisible);
    win?.addEventListener('online', onOnline);
    const detach = (): void => {
      doc?.removeEventListener('visibilitychange', onVisible);
      win?.removeEventListener('online', onOnline);
      detachers.delete(detach);
    };
    detachers.add(detach);
    return detach;
  }

  function dispose(): void {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const detach of [...detachers]) detach();
  }

  return { schedule, now, attachAutoTriggers, dispose };
}
