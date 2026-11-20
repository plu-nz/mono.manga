# App

- `App.tsx`: theme, router, bottom navigation, service-worker update prompt, and start-up loading.
- `ui.tsx`: small shared UI pieces (icons, covers, bottom sheet, progress, toasts) and translated error messages.
- `loaded.ts`: `createLoaded`, data a screen loads beside itself (last answer kept, `loading`, `error`, `refetch`).
- `sync.ts`: connects the library to the Google Drive synchronization engine and exposes its status.
- [pages/](pages/README.md): screens.

See the [source index](../README.md).
