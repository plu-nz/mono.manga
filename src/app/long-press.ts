import { onCleanup } from 'solid-js';

/** How long a press must last to count as press-and-hold. */
export const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;
/** The menu or click a browser sends right after a hold belongs to that hold. */
const FOLLOW_UP_MS = 1500;

/**
 * Press-and-hold on touch, mouse, or pen, plus right-click and the keyboard
 * context-menu key. Suppresses the browser's own menu and the click that
 * would follow the hold (so a held link does not navigate).
 */
export function longPress(onHold: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | undefined;
  let firedAt = 0;
  const justFired = () => Date.now() - firedAt < FOLLOW_UP_MS;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    start = undefined;
  };
  const fire = () => {
    cancel();
    firedAt = Date.now();
    navigator.vibrate?.(10);
    onHold();
  };
  onCleanup(cancel);

  return {
    onPointerDown(event: PointerEvent) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      start = { x: event.clientX, y: event.clientY };
      clearTimeout(timer);
      timer = setTimeout(fire, LONG_PRESS_MS);
    },
    onPointerMove(event: PointerEvent) {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(event: MouseEvent) {
      event.preventDefault();
      // Touch browsers also fire this after a hold; desktop right-click and the menu key start selection here.
      if (!justFired()) fire();
    },
    onClick(event: MouseEvent) {
      if (!justFired()) return;
      firedAt = 0;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
