# providers

Sources of titles, chapters, and pages. Each provider implements `MangaProvider` from [`../core/types.ts`](../core/types.ts).

Part of the [Manga app](../../README.md).

- [`index.ts`](index.ts): the provider registry.
- [`errors.ts`](errors.ts): `ProviderError`, whose `code` the UI translates: `rate_limited`, `network`, `not_found`, `upstream`, `empty_archive`, `unsupported_format`. `retryAfter` holds seconds for rate limits. Aborted requests reject with the standard `AbortError` and are not wrapped.
- [`mangadex/`](mangadex/README.md): the MangaDex catalog, read through this app's Worker proxy.
- [`local/`](local/README.md): CBZ/ZIP archives and image files the user imports.
