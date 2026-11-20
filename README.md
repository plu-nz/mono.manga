# Manga

Find, read, and send manga to your Kindle. A PLUNZ app at [manga.plu.nz](https://manga.plu.nz).

The interface follows the device language for English, Portuguese, and Spanish and shares an explicit choice with other PLUNZ apps on `plu.nz`.

## What it does

- **Catalog:** search [MangaDex](https://mangadex.org) by title, filtered by the chapter languages you read. Import your own CBZ, ZIP, or image files as a second source.
- **Library:** star titles to add them; the Library counts each title's new chapters every time it opens. Reading progress is kept per title.
- **Reader:** right-to-left (manga), left-to-right, and vertical (webtoon) modes, chosen per title. Tap zones, swipes, and keyboard work. Chapters can be saved offline.
- **Kindle:** pick your Kindle model and convert chapters or whole volumes into fixed-layout EPUB 3 files sized for its screen (grayscale except on color models, double-page spreads split, right-to-left order). Send them to your `@kindle.com` address from your own Gmail, or download them. The app remembers what was sent, and **Send new chapters** in the Library delivers every new chapter of your favorites in one tap.
- **Sync (optional):** with a Google account, library, progress, and settings sync through the hidden Drive `appDataFolder`.

## Architecture

Local-first and client-side. There is no database and no account. Nothing about the user or their manga is stored on a PLUNZ server.

| Concern | Where it runs |
| --- | --- |
| Library, progress, settings, offline pages | Browser IndexedDB (`src/storage`, `src/library`) |
| EPUB conversion | Browser Web Worker with `OffscreenCanvas`, one page at a time (`src/converter`) |
| Google sign-in, Drive sync, Gmail sending | Browser, Google Identity Services token model (`src/google`, `src/sync`) |
| MangaDex catalog requests | Cloudflare Worker relay (`worker/`), because `api.mangadex.org` sends no CORS headers for other sites |
| MangaDex images | Browser fetches directly; MangaDex image servers allow cross-origin reads |

The Worker is a GET-only allowlist relay with edge caching and a per-IP rate limit. It stores nothing and never sees Google tokens or files. The same Worker serves the built app through Workers Assets.

Stack: SolidJS, TypeScript, Vite, `vite-plugin-pwa`, `@solidjs/router`, `idb`, `fflate`, Hono on Cloudflare Workers, Vitest, and the shared [`@plunz/storybook`](https://github.com/plu-nz/lib.storybook) components. See the [source index](src/README.md) and the [Worker notes](worker/README.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev:worker   # Worker relay on http://127.0.0.1:8787 (needs a built or empty dist/)
pnpm dev          # app on http://localhost:5173, proxying /api to the Worker
pnpm test         # Vitest
pnpm build        # type-check app and Worker, then build dist/
pnpm verify       # tests + build
```

Copy `.env.example` to `.env.local` and set `VITE_GOOGLE_CLIENT_ID` to enable Google features locally. Without it, the app works fully except sync and Kindle email; it offers EPUB downloads instead.

## Google setup

Google features need an OAuth client in Google Cloud. The client id is public, not a secret.

1. Enable the **Gmail API** and the **Google Drive API**.
2. Google Auth Platform → Branding: app name "Manga — PLUNZ", support email, home page `https://manga.plu.nz`, privacy policy `https://manga.plu.nz/privacy.html`, authorized domain `plu.nz`.
3. Audience: External. While in Testing, add up to 100 test users.
4. Data access: `openid`, `userinfo.email`, `drive.appdata` (non-sensitive), and `gmail.send` (**sensitive**: publishing needs Google's verification with a demo video; no security assessment).
5. Credentials: OAuth client ID, type Web application. Authorized JavaScript origins: `https://manga.plu.nz` and `http://localhost:5173`. No redirect URIs are needed for the popup flow.
6. Put the client id in `.env.production` (production) or `.env.local` (development) as `VITE_GOOGLE_CLIENT_ID`.

Do not send `Cross-Origin-Opener-Policy: same-origin`, because it breaks the Google popup.

## Extra chapter sources

Titles can be linked to Weeb Central to fill chapters their provider lacks (gaps, or licensed chapters MangaDex only links to). It is open to everyone: the first use signs in with Google, and the Worker relays it only for that signed session:

- `POST /api/extra/session` takes a Google access token, checks `tokeninfo` (audience must be `GOOGLE_CLIENT_ID`, email verified) and returns an HMAC-signed session valid for 180 days. Any verified account is accepted. Setting the optional `EXTRA_SOURCES_EMAILS` secret narrows access to those addresses again; every relay request re-checks it, and rotating `EXTRA_SOURCES_SECRET` revokes all sessions.
- `/api/weebcentral/search` and `/series/:id/chapters` relay HTML as `text/plain` (parsed in the app); `/chapters/:id/pages` returns Worker-signed image URLs served by `/api/weebcentral/image`.
- Filled chapters keep the title's provider and id and set `source: 'weebcentral'`, so read marks, downloads, Kindle state, and AniList keep working per title.

Setup (secrets, never committed):

```sh
openssl rand -base64 32 | pnpm exec wrangler secret put EXTRA_SOURCES_SECRET
# Optional: restrict to some accounts
pnpm exec wrangler secret put EXTRA_SOURCES_EMAILS   # comma-separated Google emails
```

Without `EXTRA_SOURCES_SECRET` the routes answer 404 and the feature stays locked.

## AniList setup

Tracking uses AniList's implicit grant, so no server or secret is involved. AniList allows one redirect URL per client.

1. At https://anilist.co/settings/developer, create a client named "PLUNZ Manga" with redirect URL `https://manga.plu.nz/auth/anilist`.
2. Put its numeric id in `.env.production` as `VITE_ANILIST_CLIENT_ID`. For local work, create a second client with `http://localhost:5173/auth/anilist` and use its id in `.env.local`.

AniList stores one "chapters read" number per title. The app pushes the highest whole chapter read (never lowering it) and, on pull, marks chapters up to that number as read unless the user marked them unread here. MyAnimeList is not supported yet: its API sends no CORS headers, so it would need the Worker as a proxy.

## Deploy

```sh
pnpm run deploy
```

The production OAuth client id (Google Cloud project "PLUNZ Manga") is committed in `.env.production`; it is public by design.

`wrangler.jsonc` declares the `plunz-manga` Worker, its assets, the `API_LIMIT` rate-limit binding, and the `manga.plu.nz` custom domain. CI ([`ci.yml`](.github/workflows/ci.yml)) runs tests and the build through the shared PLUNZ workflow.

## Content and responsibility

PLUNZ does not host manga. Catalog data and images come from MangaDex, and chapters are credited to their scanlation groups. The app follows MangaDex's API rules: it identifies itself, rate-limits requests, credits sources, and carries no ads or paid features. It links to official releases where MangaDex lists them, and asks readers to support official editions. The privacy policy is at [`public/privacy.html`](public/privacy.html).

## Known limits

- Send to Kindle converts EPUBs on Amazon's side. Fixed layout and right-to-left order still need checking on real devices.
- Email sending splits files into parts of about 17 MiB, so each message stays under Gmail's practical 25 MB limit after base64.
- Google access tokens last about an hour and there are no refresh tokens in the browser, so the app asks you to reconnect when silent renewal fails.
- iOS Safari 16.4 or later is needed for conversion in a worker. Older browsers fall back to the main thread.
- Very tall webtoon strips are not sliced for Kindle.
