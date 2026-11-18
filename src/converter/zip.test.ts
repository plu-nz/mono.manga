import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { blobBytes, localHeaderNames } from './test-helpers';
import { crc32, utf8, ZipWriter } from './zip';

describe('ZipWriter', () => {
  it('computes CRC-32', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
  });

  it('writes a readable archive without data descriptors and predicts its size', async () => {
    const chunks: Uint8Array[] = [];
    const zip = new ZipWriter((chunk) => chunks.push(chunk), new Date(Date.UTC(2026, 10, 17, 12, 0, 0)));
    zip.addStored('a.bin', new Uint8Array([1, 2, 3]));
    zip.addDeflated('b.txt', 'hello '.repeat(100));
    zip.addDeflated('c.txt', 'x');
    const projected = zip.projectedSize;
    zip.finish();
    const bytes = await blobBytes(new Blob(chunks as BlobPart[]));
    expect(bytes.length).toBe(projected);
    const files = unzipSync(bytes);
    expect([...files['a.bin']]).toEqual([1, 2, 3]);
    expect(strFromU8(files['b.txt'])).toBe('hello '.repeat(100));
    expect(strFromU8(files['c.txt'])).toBe('x');
    const headers = localHeaderNames(bytes);
    expect(headers.map((h) => h.name)).toEqual(['a.bin', 'b.txt', 'c.txt']);
    expect(headers.map((h) => h.method)).toEqual([0, 8, 0]); // tiny text stays stored
    expect(headers.every((h) => (h.flags & 0x8) === 0)).toBe(true);
  });
});
