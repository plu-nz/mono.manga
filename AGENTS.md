# Manga agent instructions

Read this repository's `README.md`, the [PLUNZ shared context](https://github.com/plu-nz/.github/blob/main/CONTEXT.md), the [architecture standard](https://github.com/plu-nz/.github/blob/main/decisions/2026-11-03-architecture-and-stack.md), the [mobile-first and installability decision](https://github.com/plu-nz/.github/blob/main/decisions/2026-11-04-mobile-first-and-installable-apps.md), the [localization decision](https://github.com/plu-nz/.github/blob/main/decisions/2026-11-04-product-localization.md), and the [pnpm decision](https://github.com/plu-nz/.github/blob/main/decisions/2026-11-04-pnpm-package-manager.md) before changing architecture or dependencies.

## Architecture and responsibilities

Local-first SolidJS PWA. User data never reaches a PLUNZ server.

- `src/core/`: domain types and the `MangaProvider` contract. No imports.
- `src/providers/`: MangaDex (through the Worker relay) and imported files. New sources implement `MangaProvider` and register in `providers/index.ts`. Only add sources whose terms allow this use.
- `src/storage/`: IndexedDB schema and offline pages. Bump the `openDB` version with an upgrade step for schema changes; never drop user data silently.
- `src/library/`: reactive library, progress, settings, downloads, and new-chapter checks. Every synced write must bump `updatedAt`; removals are tombstones (`deleted: true`).
- `src/reader/`: page handles shared by the reader and the converter.
- `src/converter/`: EPUB 3 fixed-layout generation. Images are processed one page at a time in a Web Worker; keep memory bounded for phones.
- `src/kindle/`: device profiles and the send/download flow.
- `src/google/`, `src/sync/`: optional Google Identity Services token flow, Drive `appDataFolder`, Gmail `messages.send`, and last-write-wins merging (reading progress merges read marks per chapter). Request scopes progressively and only from user gestures.
- `src/providers/weebcentral/`, `worker/extra.ts`: extra chapter source for allowlisted accounts only. Never expose it without a session, never render relayed HTML on this origin, and keep filled chapters attached to the title's provider (`source` field).
- `src/trackers/`: optional AniList link (implicit grant, token kept only in IndexedDB). Tracker failures must never block reading.
- `src/app/`: shell, routes, screens, and shared UI. User-facing text goes through `t()` from `src/i18n` with Portuguese and Spanish entries in `src/i18n/messages.ts`.
- `worker/`: Hono Worker, a GET-only allowlist relay for `api.mangadex.org` with edge caching and rate limiting. It must not store or log user data, proxy images, or add permissive CORS.

## Conventions

- Write code, comments, documentation, issues, and commits in English. Product copy is localized in English, Portuguese, and Spanish.
- Use pnpm. Commit `pnpm-lock.yaml`; never add an npm, yarn, or Bun lockfile.
- Keep modules independent: import another module's public functions, not its internals. Keep business rules out of components where practical, and test them with Vitest.
- Use `@plunz/storybook` components (`Theme`, `Button`, `TextField`, `Card`) and its `--plz-*` tokens. Keep manga-specific controls local.
- Mobile first: 320px layouts, 44px touch targets, safe-area insets, bottom navigation, visible focus, and screen-reader labels.
- Keep MangaDex attribution and scanlation group credits visible. Do not add ads, paywalls, or server-side storage of manga.
- Every directory has a `README.md` indexing its files; update it when adding, moving, or removing files.
- Add dependencies only for a concrete need, and explain them in the change.

## Commands

- Install: `pnpm install --frozen-lockfile`.
- Develop: `pnpm dev:worker` and `pnpm dev` in separate terminals.
- Test: `pnpm test`.
- Type-check and build: `pnpm build`.
- All checks: `pnpm verify`.
- Deploy: `pnpm run deploy` (manual; the public OAuth client id comes from `.env.production`).

## Completion checks

Before completing a change, run `pnpm verify`. When behavior changes, also check:
- search and reading in the three modes;
- offline reading of a saved chapter;
- file import;
- EPUB download (open it in a reader);
- the 320px layout and keyboard use;
- installability.

For Google or Kindle changes, test with a real OAuth client and device when possible, and say so when you could not.
