"use client";

// Native-app feel on phones (iOS Safari especially): the page itself never pans, bounces or zooms.
//   - one-finger drags only scroll real scroll areas (lists, filter bars, sheets); anywhere else they're eaten,
//     so the whole page can't be dragged around or rubber-band;
//   - pinch / double-tap never zoom the page (iOS ignores user-scalable=no since iOS 10);
//   - the Mapbox map and the AR camera keep every gesture (pan, pinch-zoom, rotate, tilt).

import { useEffect } from "react";

/** Elements that own their gestures. */
const GESTURE_OWNERS = ".mapboxgl-map, .ar";

function canScroll(el: Element, dx: number, dy: number) {
  const style = getComputedStyle(el);
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 1) return false;
    // At the top pulling down, or at the bottom pushing up: that would bounce the page, not scroll the list.
    if (dy > 0 && el.scrollTop <= 0) return false;
    if (dy < 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return false;
    return true;
  }
  if (!/(auto|scroll)/.test(style.overflowX) || el.scrollWidth <= el.clientWidth + 1) return false;
  if (dx > 0 && el.scrollLeft <= 0) return false;
  if (dx < 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1) return false;
  return true;
}

export default function TouchGuard() {
  useEffect(() => {
    let startX = 0, startY = 0;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(GESTURE_OWNERS)) return;
      if (e.touches.length > 1) {
        e.preventDefault(); // page pinch-zoom
        return;
      }
      const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
      for (let el = target; el && el !== document.body; el = el.parentElement) {
        if (canScroll(el, dx, dy)) return;
      }
      if (e.cancelable) e.preventDefault();
    };
    // Safari's own pinch-zoom gesture events.
    const onGesture = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest(GESTURE_OWNERS)) e.preventDefault();
    };
    // Double-tap zoom on iOS: a second tap within 300 ms outside controls and the map.
    let lastTap = 0;
    const onEnd = (e: TouchEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const now = Date.now();
      if (now - lastTap < 300 && !target?.closest(`${GESTURE_OWNERS}, button, a, input, label, [role="button"]`) && e.cancelable) e.preventDefault();
      lastTap = now;
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: false });
    document.addEventListener("gesturestart", onGesture, { passive: false });
    document.addEventListener("gesturechange", onGesture, { passive: false });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("gesturestart", onGesture);
      document.removeEventListener("gesturechange", onGesture);
    };
  }, []);
  return null;
}
