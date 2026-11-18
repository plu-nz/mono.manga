# providers/mangadex

The MangaDex catalog: search, title details, chapter lists, pages, and update checks.

Part of [providers](../README.md). Requests go through the Worker proxy in [`../../../worker/`](../../../worker/README.md).

- [`index.ts`](index.ts): `createMangaDexProvider({ baseUrl?, fetch?, origin?, directImages? })`, plus re-exports of `mangaDexTitleUrl`, `mangaDexChapterUrl`, and `MANGADEX_ATTRIBUTION`.
- [`api.ts`](api.ts): the raw JSON types and a small client. It maps 429 to `rate_limited` (with `retryAfter`), 404 to `not_found`, other failed statuses and error results to `upstream`, and fetch failures to `network`. Aborts pass through unwrapped.
- [`map.ts`](map.ts): pure mapping covering title choice, Markdown-to-text conversion, reading-mode inference, links, and chapter sorting.
- [`policy.ts`](policy.ts): attribution, MangaDex links, and the list of removed scanlation groups.
- [`index.test.ts`](index.test.ts), [`test-fixtures.ts`](test-fixtures.ts): tests with small handwritten fixtures based on real responses.

## Mapping

- **Title:** English first, then the romanization of the original language (`ja-ro`, `ko-ro`, …), then the main title, then any variant. The other variants become `altTitles`.
- **Description:** English first, otherwise the first available language. Markdown, BBCode, and HTML are reduced to plain text: link labels are kept, images and markers are dropped, and entities are decoded.
- **Reading mode:**
  - The `Long Strip` tag gives `vertical`.
  - The `Web Comic` tag on a Korean or Chinese original also gives `vertical`.
  - Otherwise, a `ja` original gives `rtl`, and anything else gives `ltr`.
- **Covers:** `…/covers/{mangaId}/{fileName}.512.jpg`.
- **Chapters:**
  - The provider pages through `/manga/{id}/feed` 500 at a time, up to MangaDex's 10 000 offset window. It requests all content ratings and passes `includeFuturePublishAt=0`.
  - It does **not** send `includeExternalUrl`. That filter is tri-state: `1` means *only* external chapters, and leaving it out returns both.
  - Chapters with 0 pages and no `externalUrl` are skipped. Every group release of the same chapter is kept.
  - Chapters are sorted numerically by chapter number (`2 < 10 < 10.5`), then by volume. Unnumbered extras go after the last numbered chapter of their volume. Unnumbered chapters without a volume go last.
- **Pages:** `/at-home/server/{chapterId}` gives `url` in the requested quality and `fallbackUrl` in the other one.
- **Updates:**
  - `/chapter` accepts only one `manga` (`manga[]` is rejected with 400). So the provider first looks up titles in batches of 100 with `/manga?ids[]=…`, which returns `latestUploadedChapter`.
  - It then fetches those chapters in one `/chapter?ids[]=…` call per batch.
  - It reads `/manga/{id}/feed?publishAtSince=YYYY-MM-DDTHH:mm:ss` only for titles whose latest chapter is newer than `since`, running at most 2 of these requests at once.

## MangaDex policy obligations

Sources: [API docs and Acceptable Usage Policy](https://api.mangadex.org/docs/), [Limitations/Requirements](https://api.mangadex.org/docs/2-limitations/), and [Retrieving a chapter (MangaDex@Home)](https://api.mangadex.org/docs/04-chapter/retrieving-chapter/). Checked on 2026-11-17.

| Obligation | How it is handled |
|---|---|
| Credit MangaDex. | `provider.attribution` is `Data and images from MangaDex`, linking to `https://mangadex.org`. `mangaDexTitleUrl(id)` builds the "View on MangaDex" link, and details include a `MangaDex` link. |
| Credit scanlation groups when chapters can be read. | `ChapterSummary.groups` carries the group names. The UI must show them. |
| Honor written removal requests from scanlation group leaders, including groups that do not upload to MangaDex. | Add the group's UUID to `REMOVED_GROUP_IDS` in [`policy.ts`](policy.ts), and its chapters are dropped. Removing a group that is not on MangaDex needs separate handling. |
| The API is free only for projects without ads or paid services. Donations are allowed. | The app must stay free and ad-free. |
| Send a real, non-spoofed `User-Agent`. Do not send a `Via` header. | The Worker sends `PLUNZ-Manga/0.1 (+https://manga.plu.nz)` and builds upstream headers from scratch. |
| About 5 requests per second per IP. `/at-home/server` allows 40 per minute. Do not ignore 429s, which lead to temporary 403 bans. Avoid wasteful request patterns. | The edge cache shares responses across users. Each client IP is rate-limited. Upstream 429s pass through with `Retry-After`, and the provider surfaces them as `rate_limited` instead of retrying. Updates use batched lookups instead of one feed per title. |
| `offset + limit` must not exceed 10 000. | Search offsets and feed paging are clamped to that window. |
| No CORS for other sites: proxy API requests. | `/api/mangadex/*` on the same Worker. |
| Images hotlinked from MangaDex domains get a deliberately wrong response: proxy images too. | Verified: a browser `Origin` of `https://manga.plu.nz` gets a "You can read this at MangaDex" placeholder from both `uploads.mangadex.org` and MangaDex@Home nodes. Covers and pages are therefore loaded through `/api/mangadex/covers/…` and `/api/mangadex/page/…`. |
| Use `baseUrl` as-is. It is valid for at least 15 minutes. On failure, request a new one. | `baseUrl` is passed opaquely to the proxy (`?base=`). The Worker caches `at-home/server` for only 60 s, and the browser does not store it. When a page fails, call `getPages` again. |
| Do not send auth headers to image servers. | Image requests carry only `User-Agent` and `Accept`. |
| Report every image fetched from a non-`mangadex.org` base URL to `POST https://api.mangadex.network/report`, whether it succeeds or fails. | The Worker reports each upstream page fetch (`url`, `success`, `cached` from `X-Cache`, `bytes`, `duration`) with `waitUntil`. Browser reporting is not possible: the endpoint answers preflight and POST with Cloudflare 522 and no CORS headers. Images served from our edge cache cause no upstream fetch and are not reported. |
