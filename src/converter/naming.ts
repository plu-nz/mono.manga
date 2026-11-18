/** Text helpers: XML escaping, file name slugs, part titles, and identifiers. */

// Characters outside the XML 1.0 Char production (controls and lone surrogates).
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escapes text for XML element content and attribute values, dropping characters XML forbids. */
export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const MAX_FILE_NAME_LENGTH = 80;

/** ASCII-only lowercase slug; diacritics are folded, everything else becomes `-`. */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** File name for an EPUB part, e.g. `berserk-vol-2-part-1.epub`, at most 80 characters. */
export function epubFileName(title: string, part?: number): string {
  const suffix = `${part === undefined ? '' : `-part-${part}`}.epub`;
  const slug = slugify(title).slice(0, MAX_FILE_NAME_LENGTH - suffix.length).replace(/-+$/, '') || 'manga';
  return `${slug}${suffix}`;
}

export function partTitle(title: string, part: number | undefined): string {
  return part === undefined ? title : `${title} (Part ${part})`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deterministic UUID (RFC 9562 version 8, "custom") derived from a seed, so the
 * same job always produces the same book identifier.
 */
export function uuidFromSeed(seed: string): string {
  // Four independent 32-bit FNV-1a style lanes give 128 bits.
  const lanes = [0x811c9dc5, 0x01000193 ^ 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    for (let lane = 0; lane < 4; lane++) {
      lanes[lane] = Math.imul(lanes[lane] ^ (code + lane * 31), 0x01000193 + lane * 0x10000);
      lanes[lane] ^= lanes[lane] >>> 13;
    }
  }
  for (let lane = 0; lane < 4; lane++) {
    let h = lanes[lane] ^ lanes[(lane + 1) % 4];
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    lanes[lane] = (h ^ (h >>> 16)) >>> 0;
  }
  const hex = lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('').split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export function randomSeed(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** `urn:uuid:` identifier for a book (or one part of a split book). */
export function bookIdentifier(seed: string, part?: number): string {
  if (part === undefined && UUID_PATTERN.test(seed)) return `urn:uuid:${seed.toLowerCase()}`;
  return `urn:uuid:${uuidFromSeed(part === undefined ? seed : `${seed}#part-${part}`)}`;
}

/** `dcterms:modified` format: `CCYY-MM-DDThh:mm:ssZ`. */
export function modifiedTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
