import { createRoot, createSignal } from 'solid-js';
import { applyCollection, onLocalChange, readCollection } from '../library/store';
import { getGoogleState, subscribeGoogleState } from '../google/auth';
import { createDriveStore } from '../google/drive';
import { createSyncEngine, createSyncScheduler } from '../sync/engine';
import { getKv, setKv } from '../storage/db';

/**
 * Wires the library to Google Drive's hidden app folder. Synchronization is
 * opt-in: it runs only after the user connects Google with Drive access.
 */

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'error' | 'reconnect';

const state = createRoot(() => {
  const [status, setStatus] = createSignal<SyncStatus>('off');
  const [lastSync, setLastSync] = createSignal<number>();
  const [google, setGoogle] = createSignal(getGoogleState());
  return { status, setStatus, lastSync, setLastSync, google, setGoogle };
});

export const syncStatus = state.status;
export const lastSync = state.lastSync;
export const googleState = state.google;

const SYNC_ENABLED_KEY = 'sync.enabled';
const LAST_SYNC_KEY = 'sync.last';

const engine = createSyncEngine({
  local: { read: readCollection, apply: applyCollection },
  remote: createDriveStore({ interactive: false }),
});

const scheduler = createSyncScheduler(engine, {
  debounceMs: 5000,
  onReport: () => {
    const now = Date.now();
    state.setLastSync(now);
    state.setStatus('idle');
    void setKv(LAST_SYNC_KEY, now);
  },
  onError: error => {
    const code = (error as { code?: string } | undefined)?.code;
    state.setStatus(code === 'interaction_required' ? 'reconnect' : 'error');
  },
});

let enabled = false;

function canSync(): boolean {
  const google = getGoogleState();
  return enabled && google.connected && google.scopes.includes('drive');
}

export async function initSync(): Promise<void> {
  enabled = Boolean(await getKv<boolean>(SYNC_ENABLED_KEY));
  state.setLastSync(await getKv<number>(LAST_SYNC_KEY));
  state.setStatus(canSync() ? 'idle' : 'off');
  subscribeGoogleState(next => {
    state.setGoogle(next);
    if (!next.connected) state.setStatus('off');
  });
  onLocalChange(() => { if (canSync()) scheduler.schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && canSync()) void syncNow(); });
  window.addEventListener('online', () => { if (canSync()) void syncNow(); });
  if (canSync()) void syncNow();
}

export async function syncNow(): Promise<void> {
  if (!canSync()) return;
  state.setStatus('syncing');
  await scheduler.now();
}

export async function setSyncEnabled(value: boolean): Promise<void> {
  enabled = value;
  await setKv(SYNC_ENABLED_KEY, value);
  state.setStatus(canSync() ? 'idle' : 'off');
  if (value) await syncNow();
}

export function isSyncEnabled(): boolean {
  return enabled;
}
