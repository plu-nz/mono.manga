# providers/local

Titles imported from the user's own files. Nothing leaves the device.

Part of [providers](../README.md).

- [`index.ts`](index.ts): the local provider. It stores imported chapters in IndexedDB and serves them back.
- [`archive.ts`](archive.ts): parses imported files into ordered page blobs plus metadata. It uses no DOM APIs, so it also runs in workers.
  - `parseComicArchive(file, fileName)` reads CBZ/ZIP with fflate's streaming `Unzip`, so the archive is never copied whole. Only image entries and `ComicInfo.xml` are decompressed. If streaming fails, it falls back to `unzipSync` on the whole file.
  - `parseImageFiles(files, name)` groups loose images, such as a picked folder, into one chapter.
  - It keeps `jpg`, `jpeg`, `png`, `webp`, `gif`, and `avif` images, labelled with the right MIME type. It skips `__MACOSX/`, dotfiles, `Thumbs.db`, and `desktop.ini`. Pages are sorted naturally by full path, so `page2` comes before `page10`.
  - It reads `ComicInfo.xml` (`Title`, `Series`, `Number`, `Volume`, `Writer`, `Penciller`, `LanguageISO`, `Manga=YesAndRightToLeft` → `rtl`) with a small regex parser. Without a title, it falls back to the file name.
  - Errors: `empty_archive` when there are no images. `unsupported_format` for CBR/RAR, 7z, PDF, and anything that is not a readable ZIP.
- [`archive.test.ts`](archive.test.ts): tests built with fflate `zipSync` and streaming `Zip` fixtures.
