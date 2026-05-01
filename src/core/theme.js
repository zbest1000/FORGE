// Theme resolution helpers.
//
// FORGE has two themes (`theme-dark`, `theme-light`) wired through the
// `state.ui.theme` field in the store and applied as a body class by
// `applyTheme()` in `app.js`. Until UX-A this module didn't exist —
// the body class was hardcoded `theme-dark` in `index.html`, which
// caused two distinct papercuts:
//
//   1. **Flash-of-wrong-theme**: a returning user with `theme: "light"`
//      persisted in localStorage saw the dark theme briefly before
//      `app.js` finished booting and re-applied the saved preference.
//   2. **No `prefers-color-scheme` honoured**: a first-time visitor
//      with their OS in light mode still got dark.
//
// This module fixes both by exposing pure helpers that the inline
// pre-paint script in `index.html` and the store's hydrate path can
// share. Pure functions = test-friendly + zero runtime overhead.
//
// The intent ladder, highest precedence first:
//
//   1. **User-saved preference** in localStorage (`forge.state.v1`).
//      Once a user has explicitly toggled themes the choice sticks.
//   2. **OS preference** via `prefers-color-scheme: light`.
//   3. **App default** (`dark`) for any environment with no signal —
//      headless tests, screen-readers without a colour scheme media
//      query, etc.

export const THEME_DARK = "dark";
export const THEME_LIGHT = "light";
const VALID = new Set([THEME_DARK, THEME_LIGHT]);
const STORAGE_KEY = "forge.state.v1";

/**
 * Read the persisted UI theme from a JSON blob shaped like the
 * legacy store's localStorage payload (`{ ui: { theme: "dark" }, data: ... }`).
 * Returns `null` when the blob is missing, malformed, or carries an
 * unknown theme value — the caller falls through to OS preference.
 *
 * @param {string|null|undefined} raw
 * @returns {"dark"|"light"|null}
 */
export function readSavedTheme(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const t = parsed?.ui?.theme;
    return VALID.has(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Read the OS-level preference from a `MediaQueryList`-shaped object.
 * Accepts the result of `window.matchMedia("(prefers-color-scheme: light)")`
 * directly so tests can pass a fake. A `matches: true` result means the
 * user wants light; we return `"light"` for that case and `"dark"`
 * otherwise (the historical default for industrial control rooms).
 *
 * @param {{ matches: boolean } | null | undefined} mql
 * @returns {"dark"|"light"}
 */
export function readOSPreference(mql) {
  return mql && mql.matches ? THEME_LIGHT : THEME_DARK;
}

/**
 * Compose the two signals into the theme that should be applied at
 * first paint. Saved preference wins; OS preference is the fallback.
 *
 * @param {{ savedRaw?: string|null, mql?: { matches: boolean } | null }} sources
 * @returns {"dark"|"light"}
 */
export function resolveInitialTheme({ savedRaw = null, mql = null } = {}) {
  const saved = readSavedTheme(savedRaw);
  if (saved) return saved;
  return readOSPreference(mql);
}

/**
 * Side-effecting helper — reads localStorage + matchMedia from the
 * current window and applies the resulting body class. Used by the
 * inline pre-paint script in `index.html`. Safe to call repeatedly;
 * later passes overwrite the body class. The `bodyEl` argument is
 * provided so tests can drive against a JSDOM-style stub without a
 * full browser environment.
 *
 * @param {Document} [doc]
 * @param {Window} [win]
 * @returns {"dark"|"light"} the theme that was applied
 */
export function applyInitialTheme(doc = globalThis.document, win = globalThis.window) {
  let savedRaw = null;
  try { savedRaw = win?.localStorage?.getItem(STORAGE_KEY) ?? null; } catch { /* private mode */ }
  let mql = null;
  try { mql = win?.matchMedia?.("(prefers-color-scheme: light)") ?? null; } catch { /* old browser */ }
  const theme = resolveInitialTheme({ savedRaw, mql });
  if (doc?.body) {
    doc.body.classList.remove("theme-dark", "theme-light");
    doc.body.classList.add(theme === THEME_LIGHT ? "theme-light" : "theme-dark");
  }
  return theme;
}

export const _testInternals = { STORAGE_KEY };
