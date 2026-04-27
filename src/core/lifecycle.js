// Per-screen lifecycle: an AbortController that resets every time the router
// mounts a new screen, plus an opt-in `onScreenUnmount(fn)` for cleanups that
// don't fit the AbortSignal pattern (e.g. clearInterval, dexie observers).
//
// Wiring: router.js calls `_resetScreen()` before invoking each screen
// handler, which aborts the previous controller (firing all signal-bound
// listeners) and runs every callback registered with onScreenUnmount.
//
// Usage from a screen:
//   import { getScreenAbort, onScreenUnmount } from "../core/lifecycle.js";
//
//   // For fetch and addEventListener: pass the signal.
//   fetch("/api/x", { signal: getScreenAbort().signal });
//   document.addEventListener("keydown", handler, { signal: getScreenAbort().signal });
//
//   // For things that don't take a signal (timers, third-party libs):
//   const t = setInterval(tick, 1000);
//   onScreenUnmount(() => clearInterval(t));
//
// Migrating an existing screen is opt-in — screens that don't use this API
// behave exactly as before. Use it for new screens and for the worst offenders
// (workBoard, drawingViewer, search) when their leaks become a problem.

let _abort = new AbortController();
let _cleanups = new Set();

export function getScreenAbort() {
  return _abort;
}

export function onScreenUnmount(fn) {
  if (typeof fn === "function") _cleanups.add(fn);
}

// Called by the router before mounting a new screen. Not exported as part
// of the public API on purpose — only the router should drive this.
export function _resetScreen() {
  try { _abort.abort(); } catch { /* noop */ }
  for (const fn of _cleanups) {
    try { fn(); } catch (e) { console.warn("screen unmount handler threw", e); }
  }
  _cleanups = new Set();
  _abort = new AbortController();
}
