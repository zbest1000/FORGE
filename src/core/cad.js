// CAD format detection. Detects the major engineering CAD formats from
// URL extension or MIME so the viewer/server can route to the right
// renderer or converter.
//
// Server-side conversion handles DWG (LibreDWG → DXF). The viewer-side
// renderer handles DXF natively (dxf-viewer) and STEP/IGES/STL/OBJ/glTF/
// 3DM/3DS/3MF/FBX/DAE/PLY/BREP/OFF/VRML and IFC via Online3DViewer.

export const CAD_KINDS = {
  // 2D / paper-likes
  pdf:  { dim: 2, name: "PDF",  viewer: "pdf"     },
  dxf:  { dim: 2, name: "DXF",  viewer: "dxf"     }, // AutoCAD interchange
  dwg:  { dim: 2, name: "DWG",  viewer: "dxf",     needsServerConvert: "dxf" }, // AutoCAD native
  svg:  { dim: 2, name: "SVG",  viewer: "image"   },
  png:  { dim: 2, name: "PNG",  viewer: "image"   },
  jpg:  { dim: 2, name: "JPEG", viewer: "image"   },
  csv:  { dim: 2, name: "CSV",  viewer: "csv"     },
  // 3D / model formats — Online3DViewer covers these
  stp:    { dim: 3, name: "STEP",  viewer: "o3d"  },
  step:   { dim: 3, name: "STEP",  viewer: "o3d"  },
  igs:    { dim: 3, name: "IGES",  viewer: "o3d"  },
  iges:   { dim: 3, name: "IGES",  viewer: "o3d"  },
  brep:   { dim: 3, name: "BREP",  viewer: "o3d"  },
  stl:    { dim: 3, name: "STL",   viewer: "o3d"  },
  obj:    { dim: 3, name: "OBJ",   viewer: "o3d"  },
  gltf:   { dim: 3, name: "glTF",  viewer: "o3d"  },
  glb:    { dim: 3, name: "glTF",  viewer: "o3d"  },
  "3dm":  { dim: 3, name: "3DM (Rhino)", viewer: "o3d" },
  "3ds":  { dim: 3, name: "3DS",   viewer: "o3d"  },
  "3mf":  { dim: 3, name: "3MF",   viewer: "o3d"  },
  fbx:    { dim: 3, name: "FBX",   viewer: "o3d"  },
  dae:    { dim: 3, name: "Collada (DAE)", viewer: "o3d" },
  ply:    { dim: 3, name: "PLY",   viewer: "o3d"  },
  off:    { dim: 3, name: "OFF",   viewer: "o3d"  },
  wrl:    { dim: 3, name: "VRML",  viewer: "o3d"  },
  // BIM
  ifc:    { dim: 3, name: "IFC (BIM)", viewer: "ifc" },
  // Office documents — viewer-only via docx-preview / xlsx (SheetJS).
  // For full editing the recommended path is Univer (browser-side,
  // Apache-2.0); see docs/OFFICE_VIEWERS.md. We deliberately do NOT
  // depend on ONLYOFFICE Document Server (separate ~5 GB Docker).
  docx: { dim: 2, name: "Word (.docx)",  viewer: "docx" },
  doc:  { dim: 2, name: "Word (.doc)",   viewer: "docx", needsServerConvert: "docx", note: "legacy .doc requires server-side conversion" },
  xlsx: { dim: 2, name: "Excel (.xlsx)", viewer: "xlsx" },
  xls:  { dim: 2, name: "Excel (.xls)",  viewer: "xlsx", needsServerConvert: "xlsx" },
  pptx: { dim: 2, name: "PowerPoint (.pptx)", viewer: "pptx", note: "viewing requires Univer or a server-side render; placeholder for now" },
};

const MIME_MAP = {
  "application/acad":              "dwg",
  "application/x-acad":             "dwg",
  "image/vnd.dwg":                  "dwg",
  "image/x-dwg":                    "dwg",
  "application/dxf":                "dxf",
  "image/vnd.dxf":                  "dxf",
  "model/step":                     "step",
  "model/iges":                     "iges",
  "model/stl":                      "stl",
  "model/gltf+json":                "gltf",
  "model/gltf-binary":              "glb",
  "model/3mf":                      "3mf",
  "model/vnd.ifc":                  "ifc",
  "application/pdf":                "pdf",
  "image/svg+xml":                  "svg",
  "image/png":                      "png",
  "image/jpeg":                     "jpg",
  "text/csv":                       "csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword":             "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":       "xlsx",
  "application/vnd.ms-excel":       "xls",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** Lower-case extension from a URL or filename, without leading dot. */
export function extOf(urlOrName) {
  if (!urlOrName) return "";
  const clean = String(urlOrName).split("?")[0].split("#")[0].split("/").pop() || "";
  const m = clean.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/**
 * Detect which CAD kind we're dealing with. Returns null if unknown.
 *   detectCad("Plant.dwg") → { kind: "dwg", ... }
 *   detectCad("model.step") → { kind: "step", ... }
 *   detectCad(null, "model/iges") → { kind: "iges", ... }
 */
export function detectCad(urlOrName, mime) {
  let kind = null;
  if (mime) {
    kind = MIME_MAP[String(mime).toLowerCase()] || null;
  }
  if (!kind) {
    const ext = extOf(urlOrName);
    if (ext && CAD_KINDS[ext]) kind = ext;
  }
  if (!kind) return null;
  const meta = CAD_KINDS[kind];
  return { kind, ...meta };
}

/** All supported extensions, surfaced for the file-picker accept attr. */
export function supportedExtensions() {
  return Object.keys(CAD_KINDS);
}

export function acceptAttr() {
  return supportedExtensions().map(e => "." + e).join(",");
}
