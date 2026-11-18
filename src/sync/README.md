# sync

Local-first synchronization of `library`, `progress`, and `settings` through
one JSON document per collection in Google Drive `appDataFolder`
(`${collection}.json` = `{ version: 1, updatedAt, records }`).

- `merge.ts` — pure per-key merge: last write wins on `updatedAt`, ties keep
  the remote value, tombstones (`deleted: true`) win like any write and are
  pruned after 90 days.
- `engine.ts` — `createSyncEngine` (read remote → merge → apply local changes
  → write remote only if changed; one run in flight, calls during a run share
  one follow-up) and `createSyncScheduler` (debounced `schedule()`, `now()`,
  `attachAutoTriggers()` for `visibilitychange` and `online`).

A remote document with an unknown `version` is never overwritten; the run
throws `GoogleError('api')` asking the user to update the app.

Drive has no compare-and-swap. Concurrent writes from two devices may drop the
other's latest changes from the remote document, but each device keeps its
records locally and the next sync pushes them again.
