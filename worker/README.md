# worker

Cloudflare Worker (Hono) for manga.plu.nz. Static assets and the SPA are served by the assets binding. Only `/api/*` reaches this code (`run_worker_first` in [`../wrangler.jsonc`](../wrangler.jsonc)).

Part of the [Manga app](../README.md). The client that calls this proxy is in [`../src/providers/mangadex/`](../src/providers/mangadex/README.md).

## Files

- [`index.ts`](index.ts): routes, edge caching, rate limiting, and the image proxy.
- [`mangadex.ts`](mangadex.ts): the endpoint allowlist, cache TTLs, header rules, and image URL validation (no Hono dependency).
- [`index.test.ts`](index.test.ts): route tests with a mocked `fetch` and an in-memory `caches.default`.
- [`tsconfig.json`](tsconfig.json): Workers types.

## Routes

| Route | Upstream | Edge TTL | Browser |
|---|---|---|---|
| `GET /api/healthz` | n/a | n/a | `no-store` |
| `/api/mangadex/manga` (search, `ids[]` lookup) | `api.mangadex.org/manga` | 5 min | 5 min |
| `/api/mangadex/manga/tag` | same path | 1 day | 1 day |
| `/api/mangadex/manga/{uuid}` | same path | 1 h | 10 min |
| `/api/mangadex/manga/{uuid}/feed` | same path | 10 min | 5 min |
| `/api/mangadex/manga/{uuid}/aggregate` | same path | 1 h | 10 min |
| `/api/mangadex/chapter` | same path | 10 min | 5 min |
| `/api/mangadex/chapter/{uuid}` | same path | 10 min | 5 min |
| `/api/mangadex/at-home/server/{uuid}` | same path | 60 s | `no-store` |
| `/api/mangadex/cover` | same path | 1 h | 10 min |
| `/api/mangadex/statistics/manga/{uuid}` | same path | 1 h | 10 min |
| `/api/mangadex/covers/{mangaUuid}/{file}` | `uploads.mangadex.org/covers/…` | 7 days | 7 days, immutable |
| `/api/mangadex/page/{data\|data-saver}/{hash}/{file}?base=<baseUrl>` | MangaDex@Home node `baseUrl/…` | 1 day | 1 day, immutable |

Anything else under `/api/*` returns 404 JSON. Only GET and HEAD are accepted.

## Rules

- **Allowlist only.** UUIDs must be lowercase. The query string is forwarded unchanged and capped at 4 KB.
- **Headers.** Upstream requests are built from scratch, with only `User-Agent: PLUNZ-Manga/0.1 (+https://manga.plu.nz)` and `Accept`. Client cookies, auth, `Origin`, `Referer`, and `Via` never leave the Worker. Responses keep only `Content-Type` and `X-Request-ID`, so `Set-Cookie` is never returned.
- **Same origin only.** The proxy sends no CORS headers. It rejects requests whose `Sec-Fetch-Site` is `cross-site` or `same-site`, so other sites cannot hotlink it.
- **Rate limits.** `API_LIMIT` is applied per `cf-connecting-ip` to JSON routes. The optional `IMAGE_LIMIT` binding is applied to images. When a limit is hit, the Worker returns 429 JSON with `Retry-After`. Upstream 429 responses are passed through with `Retry-After`, which is computed from `X-RateLimit-Retry-After` when needed.
- **Caching.** Only 200 responses are stored in `caches.default`, under `<origin>/__edge-cache/…` keys. Page images are keyed by quality, hash, and file, not by node, because they are content-addressed.
- **Images.** The proxy fetches only `https://*.mangadex.network` or `uploads.mangadex.org`. It accepts only `image/*` responses up to 32 MB. Responses carry `nosniff` and a sandbox CSP.
- **MangaDex@Home reports.** Each upstream page fetch from a node whose URL does not contain `mangadex.org` is reported to `https://api.mangadex.network/report` with `waitUntil`, whether it succeeds or fails. The report includes `url`, `success`, `cached` (from `X-Cache`), `bytes`, and `duration`.

## Commands

```sh
pnpm exec vitest run worker
pnpm exec tsc --noEmit -p worker/tsconfig.json
mkdir -p dist && pnpm exec wrangler dev --port 8787   # local smoke test against the real API
```
