import { describe, expect, it } from 'vitest';
import { fitSize, grayscaleInPlace, isSpread, planCrops } from './image';

describe('image geometry', () => {
  it('detects spreads only when clearly landscape', () => {
    expect(isSpread(2000, 1400)).toBe(true);
    expect(isSpread(1500, 1400)).toBe(false);
    expect(isSpread(1000, 1400)).toBe(false);
  });

  it('orders spread halves by reading direction', () => {
    expect(planCrops(2001, 1400, { splitSpreads: true, direction: 'ltr' })).toEqual([
      { x: 0, y: 0, width: 1000, height: 1400 },
      { x: 1000, y: 0, width: 1001, height: 1400 },
    ]);
    expect(planCrops(2001, 1400, { splitSpreads: true, direction: 'rtl' })).toEqual([
      { x: 1000, y: 0, width: 1001, height: 1400 },
      { x: 0, y: 0, width: 1000, height: 1400 },
    ]);
  });

  it('keeps spreads whole when splitting is off', () => {
    expect(planCrops(2000, 1400, { splitSpreads: false, direction: 'rtl' })).toHaveLength(1);
  });

  it('fits large images within the box preserving aspect ratio', () => {
    expect(fitSize(2544, 3392, 1272, 1696)).toEqual({ width: 1272, height: 1696 });
    expect(fitSize(1000, 2000, 1272, 1696)).toEqual({ width: 848, height: 1696 });
  });

  it('does not upscale moderately small images', () => {
    expect(fitSize(1000, 1400, 1272, 1696)).toEqual({ width: 1000, height: 1400 });
  });

  it('upscales tiny images to fill the box', () => {
    expect(fitSize(600, 800, 1272, 1696)).toEqual({ width: 1272, height: 1696 });
  });

  it('converts RGBA to luminance and keeps alpha', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255]);
    grayscaleInPlace(data);
    expect([...data]).toEqual([76, 76, 76, 255, 150, 150, 150, 128, 29, 29, 29, 0, 255, 255, 255, 255]);
  });
});
