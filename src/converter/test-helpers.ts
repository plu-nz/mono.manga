/** Test helpers: fake JPEG pages and EPUB inspection. Not imported by app code. */
import { strFromU8, unzipSync } from 'fflate';
import type { ProcessedImage } from './epub';
import type { PageProcessor } from './processor';

/** Bytes that look like a JPEG (SOI ... EOI) of the requested size. */
export function fakeJpeg(size: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 4));
  for (let i = 2; i < bytes.length - 2; i++) bytes[i] = (i * 31 + seed * 7) & 0xff;
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}

/**
 * Processor that ignores canvas work: each source Blob's text is
 * `"<width>x<height>"`; landscape pages (as in the real pipeline) become two halves.
 */
export function fakeProcessor(options: { bytesPerPage?: number } = {}): PageProcessor & { disposed: boolean; calls: number } {
  const state = {
    disposed: false,
    calls: 0,
    async process(blob: Blob, imageOptions: { splitSpreads: boolean }, pageIndex: number): Promise<ProcessedImage[]> {
      state.calls++;
      const [width, height] = (await blob.text()).split('x').map(Number);
      const size = options.bytesPerPage ?? 1000;
      if (imageOptions.splitSpreads && width > height * 1.1) {
        return [
          { bytes: fakeJpeg(size, pageIndex * 2), width: Math.floor(width / 2), height },
          { bytes: fakeJpeg(size, pageIndex * 2 + 1), width: width - Math.floor(width / 2), height },
        ];
      }
      return [{ bytes: fakeJpeg(size, pageIndex), width, height }];
    },
    dispose() {
      state.disposed = true;
    },
  };
  return state;
}

export function pageBlobs(sizes: Array<[number, number]>): Blob[] {
  return sizes.map(([w, h]) => new Blob([`${w}x${h}`], { type: 'image/jpeg' }));
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function readEpub(blob: Blob): Promise<{ bytes: Uint8Array; files: Record<string, Uint8Array>; text(name: string): string }> {
  const bytes = await blobBytes(blob);
  const files = unzipSync(bytes);
  return { bytes, files, text: (name) => strFromU8(files[name]) };
}

/** File names in local-header order, read straight from the ZIP bytes. */
export function localHeaderNames(bytes: Uint8Array): Array<{ name: string; method: number; flags: number; offset: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ name: string; method: number; flags: number; offset: number }> = [];
  let p = 0;
  while (p + 30 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    const flags = view.getUint16(p + 6, true);
    const method = view.getUint16(p + 8, true);
    const compressed = view.getUint32(p + 18, true);
    const nameLength = view.getUint16(p + 26, true);
    const extraLength = view.getUint16(p + 28, true);
    out.push({ name: strFromU8(bytes.subarray(p + 30, p + 30 + nameLength)), method, flags, offset: p });
    p += 30 + nameLength + extraLength + compressed;
  }
  return out;
}
