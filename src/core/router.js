// Simple hash router. Routes: "#/home", "#/team-space/TS-1", "#/channel/CH-1".
// Supports optional query strings (?q=foo).

import { state } from "./store.js";

const ROUTES = [];
let currentHandler = null;
let currentParams = {};

export function defineRoute(pattern, handler) {
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

export function navigate(hash) {
  if (!hash.startsWith("#")) hash = "#" + hash;
  if (location.hash !== hash) location.hash = hash;
  else resolve();
}

export function currentPath() {
  const raw = location.hash.replace(/^#/, "") || "/home";
  return raw;
}

export function resolve() {
  const full = currentPath();
  const [path] = full.split("?");
  state.route = full;

  for (const r of ROUTES) {
    const m = path.match(r.regex);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      currentHandler = r.handler;
      currentParams = params;
      r.handler(params);
      emitRouteChange();
      return;
    }
  }

  const fallback = ROUTES.find(r => r.pattern === "/home");
  currentHandler = fallback ? fallback.handler : null;
  currentParams = {};
  state.route = "/home";
  if (fallback) fallback.handler({});
  emitRouteChange();
}

export function rerenderCurrent() {
  if (currentHandler) currentHandler(currentParams);
}

const routeListeners = new Set();
export function onRouteChange(fn) { routeListeners.add(fn); return () => routeListeners.delete(fn); }
function emitRouteChange() { routeListeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }

export function startRouter() {
  window.addEventListener("hashchange", resolve);
  if (!location.hash) location.hash = "#/home";
  else resolve();
}
