# Library

- `store.ts`: reactive library, favorites, reading progress, and settings backed by IndexedDB. Every write bumps `updatedAt` for synchronization and notifies `onLocalChange` listeners. Imported titles (`local:*`) are never synchronized.
- `manga.ts`: loads a title and its chapters with an offline fallback; chapter grouping and next/previous chapter logic.
- `download-manager.ts`: queue of offline chapter downloads with reactive progress.
- `updates.ts`: checks providers for new chapters of library titles when the app opens (at most every three hours).

See the [source index](../README.md).
