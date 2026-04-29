// Unified CAD viewer (spec §6.3 / §7.10 / §8). Picks the right renderer
// per kind and lazy-loads the OSS package on demand:
//
//   - DXF              → dxf-viewer (MIT) — three.js based 2D viewer
//   - DWG              → server converts to DXF (LibreDWG), then dxf-viewer
//   - STEP/IGES/STL/OBJ/glTF/3DM/3DS/3MF/FBX/DAE/PLY/BREP/OFF/VRML
//                       → Online3DViewer (MIT) — wraps three.js + occt-import-js
//   - IFC              → web-ifc + Online3DViewer fallback
//   - PDF / image / CSV → existing renderers in the doc viewer
//
// All viewers degrade gracefully if the CDN / converter is unavailable —
// they show a "renderer not loaded" badge and a download link instead of
// failing the whole page.

import { detectCad } from "./cad.js";
import { vendor } from "./vendor.js";
import { mode as apiMode, api, getToken } from "./api.js";

/**
 * Render a CAD asset into `host`. Returns a teardown function that
 * disposes the renderer and clears the host.
 *
 *   await renderCad(host, { url, mime, name, fileId });
 *
 * `fileId` is optional but lets DWG conversion route through
 * `/api/cad/convert/:fileId`. For raw external URLs we ask for a
 * converted blob via `?url=` if the server is reachable.
 */
export async function renderCad(host, { url = "", mime = "", name = "", fileId = "" } = {}) {
  if (!host) return () => {};
  host.innerHTML = "";

  const detected = detectCad(name || url, mime);
  if (!detected) {
    host.append(textPanel(`Unsupported file: ${name || url}.`, "warn"));
    return () => {};
  }

  const status = textPanel(`Loading ${detected.name}…`, "info");
  host.append(status);

  try {
    if (detected.viewer === "dxf" && detected.needsServerConvert === "dxf") {
      // DWG path — try the browser-side mlightcad/cad-simple-viewer
      // (libredwg-web WASM) first. If it doesn't load or the file
      // can't be parsed, fall back to the server-side LibreDWG
      // converter which produces a DXF the dxf-viewer can render.
      const browserSide = await tryRenderDwgBrowserSide(host, url, status);
      if (browserSide) return browserSide;
      const convertedUrl = await convertDwgToDxf({ url, fileId });
      return await renderDxf(host, convertedUrl, status);
    }
    if (detected.viewer === "dxf") {
      return await renderDxf(host, url, status);
    }
    if (detected.viewer === "o3d" || detected.viewer === "ifc") {
      return await renderO3D(host, url, name || url, status);
    }
    if (detected.viewer === "docx") {
      const { renderDocx } = await import("./office.js");
      status.remove();
      return await renderDocx(host, url, { name });
    }
    if (detected.viewer === "xlsx") {
      const { renderXlsx } = await import("./office.js");
      status.remove();
      return await renderXlsx(host, url, { name });
    }
    if (detected.viewer === "pptx") {
      const { renderPptx } = await import("./office.js");
      status.remove();
      return await renderPptx(host, url, { name });
    }
    // Fall through: image / PDF / CSV are handled by the doc viewer's
    // existing path; we just expose a hint here for completeness.
    status.replaceChildren(textPanel(`${detected.name} is rendered by the doc viewer.`, "info").firstChild);
    return () => {};
  } catch (err) {
    status.replaceChildren(textPanel("CAD render failed: " + (err?.message || String(err)), "danger").firstChild);
    return () => {};
  }
}

// ---------- DXF ----------
async function renderDxf(host, url, statusEl) {
  const mod = await vendor.dxfViewer();
  if (!mod) { statusEl.replaceChildren(textPanel("dxf-viewer unavailable (offline?)", "warn").firstChild); return () => {}; }
  const Ctor = mod.DxfViewer || mod.default || mod;

  host.innerHTML = "";
  const target = document.createElement("div");
  target.style.width = "100%";
  target.style.height = "70vh";
  target.style.background = "#fff";
  target.style.borderRadius = "6px";
  host.append(target);

  const viewer = new Ctor(target, {
    clearColor: 0xffffff,
    autoResize: true,
    colorCorrection: true,
    sceneOptions: { wireframeMesh: true },
  });
  await viewer.Load({ url, fonts: [], progressCbk: null });
  viewer.SubscribeToEvent("error", (e) => console.warn("[dxf-viewer]", e?.message || e));

  return () => { try { viewer.Destroy(); } catch {} host.innerHTML = ""; };
}

// ---------- Online 3D Viewer (STEP/IGES/STL/OBJ/glTF/3DM/3DS/3MF/FBX/…/IFC) ----------
async function renderO3D(host, url, name, statusEl) {
  const mod = await vendor.online3d();
  if (!mod) { statusEl.replaceChildren(textPanel("online-3d-viewer unavailable (offline?)", "warn").firstChild); return () => {}; }
  // Online3DViewer exposes `OV` namespace under the default export.
  const OV = mod.OV || mod.default || mod;

  host.innerHTML = "";
  const target = document.createElement("div");
  target.style.width = "100%";
  target.style.height = "70vh";
  target.style.background = "#0b1220";
  target.style.borderRadius = "6px";
  host.append(target);

  const viewer = new OV.EmbeddedViewer(target, {
    backgroundColor: new OV.RGBAColor(11, 18, 32, 255),
    defaultColor: new OV.RGBColor(200, 200, 200),
    edgeSettings: new OV.EdgeSettings(true, new OV.RGBColor(70, 70, 70), 30),
    environmentSettings: null,
  });
  viewer.LoadModelFromUrlList([url]);

  return () => { try { viewer.Destroy?.(); } catch {} host.innerHTML = ""; };
}

// ---------- Browser-side DWG (mlightcad/cad-simple-viewer + libredwg-web WASM) ----------
//
// Attempts to render a DWG fully in the browser. Returns the teardown
// function on success, or null on any failure (so the caller falls
// through to the server-side LibreDWG converter). Lazy-loaded — the
// WASM blob is multi-MB and only paid for when a user actually opens
// a DWG file.
async function tryRenderDwgBrowserSide(host, url, statusEl) {
  let mod;
  try { mod = await vendor.mlightcadSimple(); } catch { return null; }
  if (!mod) return null;
  // The simple-viewer package's surface evolves between releases.
  // Probe for the most stable creation entry point and bail if
  // unrecognised — better to fall through to server-convert than
  // crash on an API mismatch.
  const Viewer = mod.SimpleViewer || mod.CadViewer || mod.default;
  if (!Viewer || typeof Viewer !== "function") return null;
  try {
    host.innerHTML = "";
    const target = document.createElement("div");
    target.style.width = "100%";
    target.style.height = "70vh";
    target.style.background = "#fff";
    target.style.borderRadius = "6px";
    host.append(target);
    const viewer = new Viewer(target);
    if (typeof viewer.loadUrl === "function") {
      await viewer.loadUrl(url);
    } else if (typeof viewer.load === "function") {
      await viewer.load(url);
    } else {
      // Unknown API — clean up and fall through to the server path.
      host.innerHTML = "";
      return null;
    }
    return () => { try { viewer.dispose?.() || viewer.destroy?.(); } catch {} host.innerHTML = ""; };
  } catch (err) {
    console.warn("[cad-viewer] mlightcad browser-side failed:", err?.message || err);
    return null;
  }
}

// ---------- Server-side DWG → DXF conversion ----------
async function convertDwgToDxf({ url, fileId }) {
  // Server mode: ask FORGE to convert. The result URL points at the cached
  // DXF; the converter caches by sha256 so repeat opens are instant.
  if (apiMode() === "server") {
    if (fileId) {
      const r = await api(`/api/cad/convert/${encodeURIComponent(fileId)}?to=dxf`, { method: "POST" });
      return r.url;
    }
    if (url) {
      const r = await api(`/api/cad/convert?to=dxf`, { method: "POST", body: { url } });
      return r.url;
    }
  }
  // Demo mode: nothing we can do for binary DWG client-side. Offer a
  // download link instead.
  throw new Error("DWG conversion requires the FORGE server (LibreDWG). Switch to server mode or attach a DXF.");
}

function textPanel(text, variant = "info") {
  const wrap = document.createElement("div");
  wrap.style.padding = "16px";
  wrap.style.borderRadius = "6px";
  wrap.style.background = variant === "danger" ? "rgba(239,68,68,0.12)"
    : variant === "warn" ? "rgba(245,158,11,0.12)"
    : "var(--panel)";
  wrap.style.border = "1px solid var(--border)";
  wrap.style.color = variant === "danger" ? "var(--danger)" : variant === "warn" ? "var(--warn)" : "var(--text)";
  wrap.style.fontSize = "13px";
  wrap.textContent = text;
  return wrap;
}
