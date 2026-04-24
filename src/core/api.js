// Lightweight API client. When the client is served by the FORGE server,
// `/api/health` returns 200 and the app talks to the real backend.
// When opened from `python3 -m http.server` the health probe fails and the
// app stays in "demo mode" using the in-browser store.

const TOKEN_KEY = "forge.token.v1";

let _mode = "unknown"; // "server" | "demo" | "unknown"
let _healthCache = null;

export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; } }
export function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

export function mode() { return _mode; }

export async function probe() {
  try {
    const r = await fetch("/api/health", { credentials: "same-origin" });
    if (r.ok) {
      _healthCache = await r.json();
      _mode = "server";
      return _healthCache;
    }
  } catch { /* offline */ }
  _mode = "demo";
  return null;
}

export async function api(path, { method = "GET", body = null, headers = {} } = {}) {
  if (_mode !== "server") throw new Error("not connected to a FORGE server (demo mode)");
  const init = { method, headers: { ...headers }, credentials: "same-origin" };
  const token = getToken();
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body != null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw Object.assign(new Error(err.error || r.statusText), { status: r.status, body: err });
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
}

export async function login(email, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "login failed");
  const data = await res.json();
  setToken(data.token);
  return data.user;
}

export function logout() { setToken(null); }
