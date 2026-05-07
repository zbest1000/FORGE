// Idle scheduler (UX-G).
//
// `requestIdleCallback` lets us defer non-critical work — heavy
// viewer kickoffs (PDF.js / three.js / web-ifc), warmups, prefetch
// — until after the browser finishes painting and has spare CPU.
// The improvement is purely perceptual: the user sees the screen
// shell first, then the heavy module slots in once the browser is
// genuinely idle.
//
// Browser support:
//   * Chrome / Firefox / Edge — native rIC + cIC since 2016.
//   * Safari — STILL no stable shipping rIC as of 2026 (Apple
//     considers it a battery-life leak vector). We fall back to
//     `setTimeout(fn, 0)` so the call still happens after the
//     synchronous JS turn, just without the idle-time guarantee.
//
// API:
//   idle(fn, { timeout = 1000 })   schedule fn for next idle period
//   idleCancel(handle)             cancel a pending idle callback
//
// `timeout` is the deadline before which `fn` MUST run, even if
// the browser never reports an idle period. Default 1s; for
// must-run-within-Xms work pass a smaller value.

const _hasNative = typeof globalThis.requestIdleCallback === "function";

/**
 * Schedule a function to run during the browser's next idle period
 * (or at most `timeout` ms from now, whichever comes first).
 *
 * @param {Function} fn — work to run when idle.
 * @param {Object} [opts]
 * @param {number} [opts.timeout] hard deadline in ms (default 1000).
 * @returns {{ cancel: () => void, _native: boolean }}
 *   handle with a `cancel()` method. `_native` tells the caller
 *   whether the underlying scheduler was rIC (true) or the
 *   setTimeout fallback (false) — useful for telemetry.
 */
export function idle(fn, opts = {}) {
  if (typeof fn !== "function") return { cancel: () => {}, _native: false };
  // The Number.isFinite type guard narrows opts.timeout to `number`
  // for the Math.max call. The `?? 1000` belt-and-braces handles the
  // case where Number.isFinite is true but tsc still sees `undefined`
  // in the type union for the optional param.
  const timeout = (typeof opts.timeout === "number" && Number.isFinite(opts.timeout))
    ? Math.max(0, opts.timeout)
    : 1000;

  if (_hasNative) {
    // The native `requestIdleCallback` types its callback as
    // `IdleRequestCallback` (deadline: IdleDeadline → void). FORGE
    // callers pass arity-0 functions because we don't read the
    // deadline; tsc's structural check against the strict callback
    // type complains. Wrapping in an arity-0 closure makes the
    // assignment unambiguous.
    const id = globalThis.requestIdleCallback(() => fn(), { timeout });
    return {
      cancel: () => {
        try { globalThis.cancelIdleCallback?.(id); } catch { /* noop */ }
      },
      _native: true,
    };
  }
  // Safari + headless fallback. setTimeout(0) doesn't give us the
  // "until next paint" guarantee, but it does ensure fn doesn't
  // block the current synchronous turn — which is the main
  // observable improvement.
  const handle = setTimeout(fn, 0);
  return {
    cancel: () => clearTimeout(handle),
    _native: false,
  };
}

/**
 * Cancel a pending idle callback. Accepts the handle returned by
 * `idle()`. Safe to call multiple times; subsequent calls are no-ops.
 * @param {{ cancel: () => void } | null | undefined} handle
 */
export function idleCancel(handle) {
  if (handle && typeof handle.cancel === "function") {
    handle.cancel();
  }
}

/** Internal — used by tests to assert which path fired. */
export const _internals = { hasNative: () => _hasNative };
