import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncRecord } from '../core/types';
import type { DriveStore } from '../google/drive';
import { type Collection, type LocalSyncStore, type RemoteDocument, createSyncEngine, createSyncScheduler } from './engine';

const NOW = 1_800_000_000_000;

class MemoryLocal implements LocalSyncStore {
  data: Record<Collection, Record<string, SyncRecord>> = { library: {}, progress: {}, settings: {} };
  applied: Array<{ collection: Collection; records: Record<string, SyncRecord> }> = [];
  async read(collection: Collection) {
    return structuredClone(this.data[collection]);
  }
  async apply(collection: Collection, records: Record<string, SyncRecord>) {
    this.applied.push({ collection, records });
    Object.assign(this.data[collection], structuredClone(records));
  }
}

class MemoryDrive implements DriveStore {
  files = new Map<string, { id: string; data: unknown }>();
  writes: Array<{ name: string; data: unknown; id?: string }> = [];
  reads = 0;
  writeGate?: Promise<void>;
  private next = 1;
  async read<T>(name: string) {
    this.reads += 1;
    const file = this.files.get(name);
    return file ? { id: file.id, data: structuredClone(file.data) as T } : null;
  }
  async write(name: string, data: unknown, id?: string) {
    this.writes.push({ name, data, id });
    if (this.writeGate) await this.writeGate;
    const fileId = id ?? `file-${this.next++}`;
    this.files.set(name, { id: fileId, data: structuredClone(data) });
    return fileId;
  }
  doc(name: string): RemoteDocument | undefined {
    return this.files.get(name)?.data as RemoteDocument | undefined;
  }
}

const T0 = NOW - 1_000_000;
const rec = (value: string, t: number, deleted?: boolean) => ({ value, updatedAt: T0 + t, ...(deleted ? { deleted } : {}) });

function setup(collections: Collection[] = ['library']) {
  const local = new MemoryLocal();
  const remote = new MemoryDrive();
  const engine = createSyncEngine({ local, remote, collections, now: () => NOW });
  return { local, remote, engine };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createSyncEngine', () => {
  it('does nothing when both sides are empty', async () => {
    const { remote, engine } = setup();
    const report = await engine.sync();
    expect(report.library).toEqual({ pulled: 0, pushed: false, at: NOW });
    expect(remote.writes).toEqual([]);
  });

  it('pushes local records to a new remote document', async () => {
    const { local, remote, engine } = setup();
    local.data.library = { a: rec('a', 1) };
    const report = await engine.sync();
    expect(report.library).toEqual({ pulled: 0, pushed: true, at: NOW });
    expect(remote.doc('library.json')).toEqual({ version: 1, updatedAt: NOW, records: { a: rec('a', 1) } });
    expect(remote.writes[0].id).toBeUndefined();
  });

  it('pulls remote records without rewriting the remote', async () => {
    const { local, remote, engine } = setup();
    remote.files.set('library.json', { id: 'f1', data: { version: 1, updatedAt: 1, records: { a: rec('a', 5) } } });
    const report = await engine.sync();
    expect(report.library).toEqual({ pulled: 1, pushed: false, at: NOW });
    expect(local.data.library).toEqual({ a: rec('a', 5) });
    expect(remote.writes).toEqual([]);
  });

  it('pulls and pushes in the same run, updating the existing file id', async () => {
    const { local, remote, engine } = setup();
    remote.files.set('library.json', { id: 'f1', data: { version: 1, updatedAt: 1, records: { a: rec('remote', 5), b: rec('gone', 9, true) } } });
    local.data.library = { a: rec('local', 2), c: rec('c', 3) };
    const report = await engine.sync();
    expect(report.library).toEqual({ pulled: 2, pushed: true, at: NOW });
    expect(local.applied).toEqual([{ collection: 'library', records: { a: rec('remote', 5), b: rec('gone', 9, true) } }]);
    expect(remote.writes[0].id).toBe('f1');
    expect(remote.doc('library.json')?.records).toEqual({ a: rec('remote', 5), b: rec('gone', 9, true), c: rec('c', 3) });
    // A second run is a no-op.
    const again = await engine.sync();
    expect(again.library).toEqual({ pulled: 0, pushed: false, at: NOW });
  });

  it('syncs every collection to its own file', async () => {
    const { local, remote, engine } = setup(['library', 'progress', 'settings']);
    local.data.progress = { p: rec('p', 1) };
    local.data.settings = { settings: rec('s', 1) };
    const report = await engine.sync();
    expect(Object.keys(report).sort()).toEqual(['library', 'progress', 'settings']);
    expect([...remote.files.keys()].sort()).toEqual(['progress.json', 'settings.json']);
  });

  it('refuses to overwrite an unknown remote version', async () => {
    const { local, remote, engine } = setup(['library', 'progress']);
    remote.files.set('library.json', { id: 'f1', data: { version: 2, updatedAt: 1, records: {} } });
    local.data.library = { a: rec('a', 1) };
    local.data.progress = { p: rec('p', 1) };
    await expect(engine.sync()).rejects.toMatchObject({ code: 'api', message: expect.stringContaining('version 2') });
    expect(remote.doc('library.json')?.version).toBe(2);
    // Other collections still sync.
    expect(remote.doc('progress.json')?.records).toEqual({ p: rec('p', 1) });
  });

  it('refuses to overwrite a malformed remote document', async () => {
    const { remote, engine } = setup();
    remote.files.set('library.json', { id: 'f1', data: ['nope'] });
    await expect(engine.sync()).rejects.toMatchObject({ code: 'api' });
    expect(remote.writes).toEqual([]);
  });

  it('runs one sync at a time and coalesces calls into one follow-up', async () => {
    const { local, remote, engine } = setup();
    let release!: () => void;
    remote.writeGate = new Promise((resolve) => (release = resolve));
    local.data.library = { a: rec('a', 1) };

    const first = engine.sync();
    const second = engine.sync();
    const third = engine.sync();
    expect(second).toBe(third);
    await vi.waitFor(() => expect(remote.writes).toHaveLength(1));
    expect(remote.reads).toBe(1);

    // A local write lands while the first run is still uploading.
    local.data.library.b = rec('b', 2);
    remote.writeGate = undefined;
    release();
    await first;
    const followUp = await second;
    expect(remote.reads).toBe(2);
    expect(followUp.library.pushed).toBe(true);
    expect(remote.doc('library.json')?.records).toEqual({ a: rec('a', 1), b: rec('b', 2) });
  });

  it('runs the follow-up even when the first run fails', async () => {
    const { remote, engine } = setup();
    const read = vi.spyOn(remote, 'read').mockRejectedValueOnce(new Error('boom'));
    const first = engine.sync();
    const second = engine.sync();
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toHaveProperty('library');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('createSyncScheduler', () => {
  it('debounces schedule() and reports', async () => {
    vi.useFakeTimers();
    const sync = vi.fn().mockResolvedValue({ library: { pulled: 0, pushed: false, at: 1 } });
    const onReport = vi.fn();
    const scheduler = createSyncScheduler({ sync }, { debounceMs: 1000, onReport });
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it('now() cancels the pending debounce and forwards errors', async () => {
    vi.useFakeTimers();
    const error = new Error('fail');
    const sync = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const scheduler = createSyncScheduler({ sync }, { onError });
    scheduler.schedule();
    await expect(scheduler.now()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('syncs on visibilitychange (visible) and online, until detached', async () => {
    const sync = vi.fn().mockResolvedValue({});
    const scheduler = createSyncScheduler({ sync });
    const detach = scheduler.attachAutoTriggers();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(sync).toHaveBeenCalledTimes(2);
    detach();
    window.dispatchEvent(new Event('online'));
    expect(sync).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('skips runs while offline', async () => {
    const sync = vi.fn().mockResolvedValue({});
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const scheduler = createSyncScheduler({ sync });
    await expect(scheduler.now()).resolves.toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
    online.mockRestore();
  });
});
