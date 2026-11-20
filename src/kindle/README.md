# Kindle

- `profiles.ts`: Kindle models and their screen resolutions, used to size converted pages.
- `send.ts`: plans export files (one file, per volume, or per chapter), streams pages into the converter, and downloads results.
- `auto.ts`: picks the chapters not yet sent for a title (one release per chapter number, after the last sent chapter, the chapter being read, or only the latest one).
- `batch.ts`: "Send new chapters" — refreshes every favorite, converts each title's new chapters into one EPUB (split by size), emails it, and records what was sent.
- `BatchSheet.tsx`: the one-tap sheet for that flow, opened from the Library.
- `SendSheet.tsx`: the "Send to Kindle" sheet — sends one EPUB per chapter right away through `google/gmail.ts`, showing progress; it asks for the Kindle email once, and offers EPUB download only when Google sign-in is unavailable.

See the [source index](../README.md).
