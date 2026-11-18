# Source

The browser app. Each directory is a module with a narrow responsibility; modules import each other's public functions, never each other's internals.

- [core/](core/README.md): domain types and the provider contract. No dependencies.
- [providers/](providers/README.md): catalog sources (MangaDex, imported files) behind one interface.
- [storage/](storage/README.md): IndexedDB schema, offline pages, cached titles.
- [library/](library/README.md): library, favorites, progress, settings, offline downloads, new-chapter checks.
- [reader/](reader/README.md): page loading for the reader and the converter.
- [converter/](converter/README.md): Kindle EPUB generation in a Web Worker.
- [kindle/](kindle/README.md): device profiles and the send/download flow.
- [google/](google/README.md): optional Google sign-in, Drive app data, and Gmail sending, all from the browser.
- [sync/](sync/README.md): merge rules and the Drive synchronization engine.
- [i18n/](i18n/README.md): English, Portuguese, and Spanish interface text.
- [app/](app/README.md): SolidJS shell, routes, and screens.
- [test/](test/README.md): shared test setup.

`main.tsx` mounts the app; `style.css` holds the mobile-first styles on top of the shared PLUNZ tokens.

See the [repository README](../README.md).
