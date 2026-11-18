import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS, longPress } from './long-press';

const pointer = (x = 0, y = 0, extra: Partial<PointerEvent> = {}) => ({ clientX: x, clientY: y, pointerType: 'touch', button: 0, ...extra }) as PointerEvent;
const click = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as MouseEvent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('longPress', () => {
  it('fires after holding and swallows the click that follows', () => {
    const onHold = vi.fn();
    createRoot(dispose => {
      const handlers = longPress(onHold);
      handlers.onPointerDown(pointer());
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(onHold).toHaveBeenCalledTimes(1);
      // The browser's own long-press menu does not fire it twice.
      handlers.onContextMenu(click());
      expect(onHold).toHaveBeenCalledTimes(1);
      const event = click();
      handlers.onClick(event);
      expect(event.preventDefault).toHaveBeenCalled();
      // A later right-click starts again.
      vi.advanceTimersByTime(2000);
      handlers.onContextMenu(click());
      expect(onHold).toHaveBeenCalledTimes(2);
      dispose();
    });
  });

  it('ignores short taps and presses that turn into scrolls', () => {
    const onHold = vi.fn();
    createRoot(dispose => {
      const handlers = longPress(onHold);
      handlers.onPointerDown(pointer());
      handlers.onPointerUp();
      vi.advanceTimersByTime(LONG_PRESS_MS);
      handlers.onPointerDown(pointer());
      handlers.onPointerMove(pointer(0, 30));
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(onHold).not.toHaveBeenCalled();
      const event = click();
      handlers.onClick(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      dispose();
    });
  });

  it('starts from right-click or the menu key', () => {
    const onHold = vi.fn();
    createRoot(dispose => {
      longPress(onHold).onContextMenu(click());
      expect(onHold).toHaveBeenCalledTimes(1);
      dispose();
    });
  });
});
