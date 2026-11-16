// Pointer input policy: Apple Pencil vs finger, palm rejection, scroll suppression
import { useApp } from './store';

/** True if this pointer should draw ink given current settings */
export function pointerDraws(e: PointerEvent | React.PointerEvent): boolean {
  const s = useApp.getState();
  if (e.pointerType === 'pen' || e.pointerType === 'mouse') return true;
  const mode = s.settings.pencilOnly;
  if (mode === 'on') return false;
  if (mode === 'off') return true;
  return !s.penSeen; // auto: once a pencil is seen, fingers navigate
}

export function notePointer(e: PointerEvent | React.PointerEvent) {
  if (e.pointerType === 'pen' && !useApp.getState().penSeen) useApp.setState({ penSeen: true });
}

// When the Apple Pencil touches the screen, iOS also produces touch events that would scroll
// the page. Block those (touchType === 'stylus') so the pencil only draws/selects.
let blockTouchScroll = false;
export function setGestureLock(v: boolean) {
  blockTouchScroll = v;
}

if (typeof window !== 'undefined') {
  const handler = (e: TouchEvent) => {
    const t = e.touches[0] || e.changedTouches[0];
    const stylus = t && (t as any).touchType === 'stylus';
    if (stylus || blockTouchScroll) {
      // allow text inputs to receive pencil (Scribble) input
      const tgt = e.target as HTMLElement;
      if (tgt && tgt.closest && tgt.closest('input,textarea,[contenteditable="true"],.allow-touch')) return;
      if (e.cancelable) e.preventDefault();
    }
  };
  window.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t && (t as any).touchType === 'stylus') {
      useApp.getState().penSeen || useApp.setState({ penSeen: true });
    }
    handler(e);
  }, { passive: false });
  window.addEventListener('touchmove', handler, { passive: false });
  // prevent iOS double-tap zoom / pinch-zooming the whole app
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => {
    const tgt = e.target as HTMLElement;
    if (!tgt.closest('input,textarea,[contenteditable="true"]')) e.preventDefault();
  });
}

export function coalesced(e: PointerEvent): PointerEvent[] {
  const ce = (e as any).getCoalescedEvents?.();
  return ce && ce.length ? ce : [e];
}

export function pressureOf(e: PointerEvent): number {
  if (e.pointerType === 'pen') return e.pressure || 0.5;
  return 0.5;
}

export function isPrimaryButton(e: PointerEvent | React.PointerEvent) {
  return e.button === 0 || e.pointerType !== 'mouse';
}
