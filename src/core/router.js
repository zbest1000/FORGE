// Simple hash router. Routes: "#/home", "#/team-space/TS-1", "#/channel/CH-1".
// Supports optional query strings (?q=foo).

import { state } from "./store.js";
import { logger } from "./logging.js";

/** @typedef {(params: any) => void} RouteHandler */
/** @typedef {{ pattern: string, regex: RegExp, keys: string[], handler: RouteHandler }} RouteEntry */

/** @type {RouteEntry[]} */
const ROUTES = [];
/** @type {RouteHandler | null} */
let currentHandler = null;
/** @type {Record<string, string>} */
let currentParams = {};

/**
 * @param {string} pattern
 * @param {RouteHandler} handler
 */
export function defineRoute(pattern, handler) {
  /** @type {string[]} */
  const keys = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$"
  );
  ROUTES.push({ pattern, regex, keys, handler });
}

/** @param {string} hash */
export function navigate(hash) {
  if (!hash.startsWith("#")) hash = "#" + hash;
  if (location.hash !== hash) location.hash = hash;
  else resolve();
}

export function currentPath() {
  const raw = location.hash.replace(/^#/, "") || "/hub";
  return raw;
}

export function resolve() {
  const full = currentPath();
  const [path] = full.split("?");
  state.route = full;

  for (const r of ROUTES) {
    const m = path.match(r.regex);
    if (m) {
      /** @type {Record<string, string>} */
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      currentHandler = r.handler;
      currentParams = params;
      r.handler(params);
      emitRouteChange();
      return;
    }
  }

  const fallback = ROUTES.find(r => r.pattern === "/hub") || ROUTES.find(r => r.pattern === "/home");
  currentHandler = fallback ? fallback.handler : null;
  currentParams = {};
  state.route = fallback ? fallback.pattern : "/hub";
  if (fallback) fallback.handler({});
  emitRouteChange();
}

export function rerenderCurrent() {
  if (currentHandler) currentHandler(currentParams);
}

/** @type {Set<(state: any) => void>} */
const routeListeners = new Set();
/** @param {(state: any) => void} fn */
export function onRouteChange(fn) { routeListeners.add(fn); return () => routeListeners.delete(fn); }
function emitRouteChange() { routeListeners.forEach(fn => { try { fn(state); } catch (e) { logger.error("router.listener.threw", e); } }); }

export function startRouter() {
  window.addEventListener("hashchange", resolve);
  if (!location.hash) location.hash = "#/hub";
  else resolve();
}

/**
 * Parsed query params from the current hash. `#/work?status=Open&due=overdue`
 * returns `URLSearchParams` you can read via `.get("status")` or iterate.
 *
 * Why this exists: filter state was previously parked in sessionStorage,
 * which meant URLs couldn't be shared, bookmarked, or used as undo
 * history. Screens that opted into URL-driven filters call this on
 * mount and keep the URL as the single source of truth.
 */
export function queryParams() {
  const [, qs = ""] = currentPath().split("?");
  return new URLSearchParams(qs);
}

/**
 * Patch the current URL's query string with the given key/value pairs.
 * `null` / `undefined` / "" values delete the key. Re-renders the screen
 * by going through the standard hash-change path so listeners stay in
 * lockstep.
 * @param {Record<string, string | number | boolean | null | undefined>} patch
 */
export function updateQueryParams(patch) {
  const [path, qs = ""] = currentPath().split("?");
  const params = new URLSearchParams(qs);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "" || v === false) params.delete(k);
    else params.set(k, String(v));
  }
  const next = params.toString();
  navigate("#" + path + (next ? "?" + next : ""));
}
