/**
 * Image pipeline: decode a page, split landscape spreads, fit to the Kindle
 * screen, convert to grayscale for e-ink profiles, and encode as JPEG.
 *
 * The same code runs inside the Web Worker (OffscreenCanvas) and, as a
 * fallback, on the main thread (OffscreenCanvas or a DOM canvas). Geometry and
 * pixel helpers are pure and unit-tested; the canvas parts need a browser.
 */
import type { ProcessedImage } from './epub';
import { ConversionError } from './errors';

export interface ImageOptions {
  /** Target box (Kindle profile resolution). */
  maxWidth: number;
  maxHeight: number;
  grayscale: boolean;
  splitSpreads: boolean;
  direction: 'ltr' | 'rtl';
  /** JPEG quality, 0..1. */
  quality: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A page counts as a two-page spread when it is this much wider than tall. */
export const SPREAD_RATIO = 1.1;
/**
 * Images are never enlarged unless they are tiny: when the image is at most
 * this fraction of the target box (in its limiting dimension), it is upscaled to
 * fill the box. Otherwise it keeps its size and the reader scales it.
 */
export const UPSCALE_BELOW = 0.6;

export function isSpread(width: number, height: number): boolean {
  return width > height * SPREAD_RATIO;
}

/** Source rectangles for the output pages of one image, in reading order. */
export function planCrops(width: number, height: number, options: Pick<ImageOptions, 'splitSpreads' | 'direction'>): CropRect[] {
  if (!options.splitSpreads || !isSpread(width, height)) return [{ x: 0, y: 0, width, height }];
  const leftWidth = Math.floor(width / 2);
  const left: CropRect = { x: 0, y: 0, width: leftWidth, height };
  const right: CropRect = { x: leftWidth, y: 0, width: width - leftWidth, height };
  return options.direction === 'rtl' ? [right, left] : [left, right];
}

/** Output size: fit within the box preserving aspect ratio (see `UPSCALE_BELOW`). */
export function fitSize(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const fit = Math.min(maxWidth / width, maxHeight / height);
  const scale = fit < 1 || fit >= 1 / UPSCALE_BELOW ? fit : 1;
  return {
    width: Math.max(1, Math.min(maxWidth, Math.round(width * scale))),
    height: Math.max(1, Math.min(maxHeight, Math.round(height * scale))),
  };
}

/** In-place RGBA → luminance (ITU-R BT.601 weights, as used by JPEG and KCC). */
export function grayscaleInPlace(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const y = (19595 * data[i] + 38470 * data[i + 1] + 7471 * data[i + 2] + 32768) >> 16;
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
  }
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

export interface RasterSurface {
  context: Context2D;
  encodeJpeg(quality: number): Promise<Blob>;
  release(): void;
}

export interface CanvasBackend {
  decode(blob: Blob): Promise<DecodedImage>;
  createSurface(width: number, height: number, options: { willReadFrequently: boolean }): RasterSurface;
}

async function decodeWithImageBitmap(blob: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob);
  return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
}

async function decodeWithImageElement(blob: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => {
      URL.revokeObjectURL(url);
      image.src = '';
    },
  };
}

function hasOffscreenCanvas2d(): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    return canvas.getContext('2d') !== null && typeof canvas.convertToBlob === 'function';
  } catch {
    return false;
  }
}

function context2d(canvas: OffscreenCanvas | HTMLCanvasElement, willReadFrequently: boolean): Context2D {
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently }) as Context2D | null;
  if (!context) throw new ConversionError('unsupported_browser', 'Canvas 2D is not available.');
  return context;
}

export function offscreenCanvasBackend(): CanvasBackend {
  return {
    decode: decodeWithImageBitmap,
    createSurface(width, height, { willReadFrequently }) {
      const canvas = new OffscreenCanvas(width, height);
      return {
        context: context2d(canvas, willReadFrequently),
        encodeJpeg: (quality) => canvas.convertToBlob({ type: 'image/jpeg', quality }),
        release() {
          // Shrinking the canvas frees its backing store promptly (notably on Safari).
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    },
  };
}

export function domCanvasBackend(): CanvasBackend {
  return {
    async decode(blob) {
      if (typeof createImageBitmap === 'function') {
        try {
          return await decodeWithImageBitmap(blob);
        } catch {
          // Fall through: some engines decode more formats through <img>.
        }
      }
      return decodeWithImageElement(blob);
    },
    createSurface(width, height, { willReadFrequently }) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return {
        context: context2d(canvas, willReadFrequently),
        encodeJpeg: (quality) =>
          new Promise<Blob>((resolve, reject) =>
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), 'image/jpeg', quality),
          ),
        release() {
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    },
  };
}

/** Best canvas backend in the current context, or `null` when there is none. */
export function detectCanvasBackend(): CanvasBackend | null {
  if (hasOffscreenCanvas2d() && typeof createImageBitmap === 'function') return offscreenCanvasBackend();
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') return domCanvasBackend();
  return null;
}

/**
 * Converts one source page into one or two Kindle-ready JPEG pages. Holds at
 * most one decoded image and one canvas at a time and releases both before
 * returning.
 */
export async function processImage(blob: Blob, options: ImageOptions, backend: CanvasBackend, pageIndex?: number): Promise<ProcessedImage[]> {
  let decoded: DecodedImage;
  try {
    decoded = await backend.decode(blob);
  } catch (cause) {
    throw new ConversionError('image_decode_failed', `Could not decode page image (${blob.type || 'unknown type'}).`, { pageIndex, cause });
  }
  try {
    if (!decoded.width || !decoded.height) {
      throw new ConversionError('image_decode_failed', 'Page image has no pixels.', { pageIndex });
    }
    const output: ProcessedImage[] = [];
    for (const crop of planCrops(decoded.width, decoded.height, options)) {
      const { width, height } = fitSize(crop.width, crop.height, options.maxWidth, options.maxHeight);
      const surface = backend.createSurface(width, height, { willReadFrequently: options.grayscale });
      try {
        const context = surface.context;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(decoded.source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
        if (options.grayscale) {
          const pixels = context.getImageData(0, 0, width, height);
          grayscaleInPlace(pixels.data);
          context.putImageData(pixels, 0, 0);
        }
        let jpeg: Blob;
        try {
          jpeg = await surface.encodeJpeg(options.quality);
        } catch (cause) {
          throw new ConversionError('image_encode_failed', 'Could not encode page as JPEG.', { pageIndex, cause });
        }
        if (jpeg.type !== 'image/jpeg') {
          throw new ConversionError('image_encode_failed', `Browser produced ${jpeg.type || 'an unknown type'} instead of JPEG.`, { pageIndex });
        }
        output.push({ bytes: new Uint8Array(await jpeg.arrayBuffer()), width, height });
      } finally {
        surface.release();
      }
    }
    return output;
  } finally {
    decoded.close();
  }
}
