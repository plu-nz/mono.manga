# Storage

Everything the app keeps lives in the browser's IndexedDB database `plunz-manga`.

- `db.ts`: schema (library, progress, key-value settings, cached titles, downloads, pages, updates), connection, and persistent-storage helpers.
- `downloads.ts`: offline chapters — page blobs, resumable downloads with limited concurrency, and imported files.
- `manga-cache.ts`: the last fetched details and chapter list of each title, so title pages open offline.

See the [source index](../README.md).
