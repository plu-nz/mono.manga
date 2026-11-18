/**
 * Minimal streaming ZIP writer for EPUB containers.
 *
 * fflate's streaming `Zip` always sets general-purpose flag bit 3 and writes
 * data descriptors, even for stored entries. Java's `ZipInputStream` (used by
 * EPUB tooling) rejects stored entries with data descriptors, and the EPUB OCF
 * `mimetype` entry is expected to carry real sizes in its local header. Every
 * entry here is complete when added, so local headers carry the CRC and sizes
 * and no data descriptors are written. Text is compressed with fflate's raw
 * DEFLATE; images are stored.
 *
 * Each entry is emitted to the sink as soon as it is added, so the writer only
 * keeps the (small) central directory in memory.
 */
import { deflateSync } from 'fflate';
import { ConversionError } from './errors';

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_ZIP32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

interface CentralEntry {
  name: Uint8Array;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Bytes a file name adds to the archive outside its data (local + central headers). */
export function zipEntryOverhead(name: string): number {
  return LOCAL_HEADER_SIZE + CENTRAL_HEADER_SIZE + 2 * utf8(name).length;
}

export class ZipWriter {
  private readonly entries: CentralEntry[] = [];
  private readonly time: number;
  private readonly date: number;
  private offset = 0;
  private finished = false;

  constructor(private readonly sink: (chunk: Uint8Array) => void, modified: Date = new Date()) {
    const dos = dosDateTime(modified);
    this.time = dos.time;
    this.date = dos.date;
  }

  /** Bytes already emitted to the sink. */
  get bytesWritten(): number {
    return this.offset;
  }

  /** Exact size of the archive if it were finished now. */
  get projectedSize(): number {
    let central = END_OF_CENTRAL_DIRECTORY_SIZE;
    for (const entry of this.entries) central += CENTRAL_HEADER_SIZE + entry.name.length;
    return this.offset + central;
  }

  addStored(name: string, data: Uint8Array): void {
    this.addEntry(name, data, data, 0);
  }

  /** Adds a DEFLATE-compressed entry (stored instead when compression does not help). */
  addDeflated(name: string, data: Uint8Array | string): void {
    const raw = typeof data === 'string' ? utf8(data) : data;
    const compressed = deflateSync(raw, { level: 9 });
    if (compressed.length < raw.length) this.addEntry(name, raw, compressed, 8);
    else this.addEntry(name, raw, raw, 0);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const centralSize = this.entries.reduce((sum, entry) => sum + CENTRAL_HEADER_SIZE + entry.name.length, 0);
    const out = new Uint8Array(centralSize + END_OF_CENTRAL_DIRECTORY_SIZE);
    const view = new DataView(out.buffer);
    let p = 0;
    for (const entry of this.entries) {
      view.setUint32(p, 0x02014b50, true);
      view.setUint16(p + 4, 20, true); // version made by: 2.0, MS-DOS attributes
      view.setUint16(p + 6, entry.method === 8 ? 20 : 10, true);
      view.setUint16(p + 8, 0, true); // flags
      view.setUint16(p + 10, entry.method, true);
      view.setUint16(p + 12, this.time, true);
      view.setUint16(p + 14, this.date, true);
      view.setUint32(p + 16, entry.crc, true);
      view.setUint32(p + 20, entry.compressedSize, true);
      view.setUint32(p + 24, entry.size, true);
      view.setUint16(p + 28, entry.name.length, true);
      // extra length, comment length, disk number, internal and external attributes stay 0
      view.setUint32(p + 42, entry.offset, true);
      out.set(entry.name, p + CENTRAL_HEADER_SIZE);
      p += CENTRAL_HEADER_SIZE + entry.name.length;
    }
    view.setUint32(p, 0x06054b50, true);
    view.setUint16(p + 8, this.entries.length, true);
    view.setUint16(p + 10, this.entries.length, true);
    view.setUint32(p + 12, centralSize, true);
    view.setUint32(p + 16, this.offset, true);
    this.emit(out);
  }

  private addEntry(name: string, raw: Uint8Array, payload: Uint8Array, method: number): void {
    if (this.finished) throw new Error('ZIP archive is already finished.');
    const nameBytes = utf8(name);
    if (this.entries.length >= MAX_ENTRIES || this.offset + LOCAL_HEADER_SIZE + nameBytes.length + payload.length > MAX_ZIP32) {
      throw new ConversionError('too_large', 'The book is too large for a single EPUB file.');
    }
    const entry: CentralEntry = { name: nameBytes, method, crc: crc32(raw), compressedSize: payload.length, size: raw.length, offset: this.offset };
    const header = new Uint8Array(LOCAL_HEADER_SIZE + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, method === 8 ? 20 : 10, true);
    view.setUint16(6, 0, true); // flags: no data descriptor, ASCII names
    view.setUint16(8, method, true);
    view.setUint16(10, this.time, true);
    view.setUint16(12, this.date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.compressedSize, true);
    view.setUint32(22, entry.size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // no extra field (required for the EPUB mimetype entry)
    header.set(nameBytes, LOCAL_HEADER_SIZE);
    this.emit(header);
    this.emit(payload);
    this.entries.push(entry);
  }

  private emit(chunk: Uint8Array): void {
    this.offset += chunk.length;
    this.sink(chunk);
  }
}
