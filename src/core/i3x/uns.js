// UNS path helpers.
// A UNS path is a slash-separated hierarchical address that every contextualized
// asset or signal lives at, e.g.:
//   atlas/north-plant/line-a/cell-3/hx-01/temp
// Segments are lower-kebab-case. The UNS root for this workspace is the organization slug.

export function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function joinPath(...parts) {
  const segs = [];
  for (const raw of parts) {
    if (raw == null || raw === "") continue;
    const list = Array.isArray(raw) ? raw : String(raw).split("/");
    for (const s of list) {
      if (s === "" || s == null) continue;
      segs.push(slug(s));
    }
  }
  return segs.filter(Boolean).join("/");
}

export function parentPath(path) {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

export function leafName(path) {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function pathDepth(path) {
  if (!path) return 0;
  return path.split("/").length;
}

export function ancestors(path) {
  const parts = path.split("/");
  const out = [];
  for (let i = 1; i <= parts.length; i++) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}
