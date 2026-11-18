# Converter

Turns manga page images into Kindle-ready fixed-layout EPUB 3 files, entirely in the browser. Device resolutions come from [`../kindle/profiles.ts`](../kindle/profiles.ts). The domain contract is in [`../core/types.ts`](../core/types.ts).

`convertToEpub(job, pages, { total, onProgress, signal })` takes page Blobs one at a time and processes each in a Web Worker (or on the main thread when workers can't draw). It streams the results into one or more EPUB parts that each stay under `maxPartBytes`. Errors a user may see are `ConversionError`s with a `code` the UI translates.

## Files

- [`index.ts`](index.ts): public API (`convertToEpub`, types, `ConversionError`, Kindle profiles).
- [`convert.ts`](convert.ts): conversion driver. Handles pulling pages, splitting parts by size, mapping TOC entries to parts, progress, and abort. Takes any `PageProcessor`, so tests can drive it with pre-encoded JPEG bytes.
- [`epub.ts`](epub.ts): fixed-layout EPUB writer, with OPF, XHTML pages, `nav.xhtml`, and `toc.ncx` templates. Follows Kindle Comic Converter conventions.
- [`zip.ts`](zip.ts): minimal streaming ZIP writer. It writes no data descriptors, and `mimetype` is stored first, as EPUB OCF requires. Text is compressed with fflate's DEFLATE.
- [`image.ts`](image.ts): image pipeline. Decodes, splits spreads, fits to the screen, converts to grayscale, and encodes JPEG. Includes OffscreenCanvas and DOM canvas backends.
- [`processor.ts`](processor.ts): worker-backed and main-thread page processors, and the capability probe.
- [`converter.worker.ts`](converter.worker.ts) and [`protocol.ts`](protocol.ts): the worker and its message types.
- [`errors.ts`](errors.ts): `ConversionError` and its codes.
- [`naming.ts`](naming.ts): XML escaping, file name slugs, part titles, and deterministic book identifiers.
- [`test-helpers.ts`](test-helpers.ts): fake JPEG pages, a fake processor, and EPUB inspection, for tests only.
- `*.test.ts`: Vitest suites. They run without a canvas.
