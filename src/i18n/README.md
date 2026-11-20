# Localization

Follows the PLUNZ localization decision: English, Portuguese, and Spanish; device language by default; English fallback; the shared `plunz_locale` cookie on `plu.nz`.

- `index.ts`: current locale, `t()`/`tn()` translation helpers with `{name}` placeholders, and locale-aware formatting.
- `messages.ts`: English source strings mapped to Portuguese and Spanish.
- `locale-preference.ts`: shared cookie with a local fallback (same as Split).

See the [source index](../README.md).
