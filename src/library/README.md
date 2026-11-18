# Library

- `store.ts`: reactive library, favorites, reading progress, and settings backed by IndexedDB. Every write bumps `updatedAt` for synchronization and notifies `onLocalChange` listeners. Imported titles (`local:*`) are never synchronized.
- `manga.ts`: loads a title and its chapters with an offline fallback; chapter grouping and next/previous chapter logic.
- `download-manager.ts`: queue of offline chapter downloads with reactive progress.
- `recent.ts`: recent searches and recently opened titles shown on the Search screen; kept on this device only, never synced.
- `new-chapters.ts`: refreshes each favorite's chapter list when the Favorites screen opens (reused for 10 minutes) and derives its count of new chapters — after the last one sent to the Kindle or the one being read.

See the [source index](../README.md).
