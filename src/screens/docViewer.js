// Document viewer v2 — spec §7 engineering records, §11.5 UX.
//
// Adds:
//   * Multi-page "paper" with overview strip + page navigation
//   * Pinned regional comment threads (page, x, y, author, replies)
//   * Rich metadata panel (discipline/project/package/area/line/system/
//     vendor/revision/approver/effective date)
//   * Transmittals list + "Draft transmittal" flow
//   * One-click issue creation from a comment pin
//   * Revision timeline with supersede chain markers
//   * Approval banner + request-approval flow (delegated to /approvals)

import { el, mount, card, badge, toast, chip, modal, formRow, input, select, textarea, prompt, loadingState, inputWithSuggestions, confirm } from "../core/ui.js";
import { idle } from "../core/idle.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { follow, unfollow, isFollowing } from "../core/subscriptions.js";
import { impactOfRevision } from "../core/revisions.js";
import { openPdf, renderPage } from "../core/pdf.js";
import { parseCSV } from "../core/csv.js";
import { detectCad, supportedExtensions } from "../core/cad.js";
import { renderCad } from "../core/cad-viewer.js";
import { currentUserId, currentUser, currentRole } from "../core/groups.js";
import { buildAnnotationOverlay, listAnnotations } from "../core/pdfAnnotations.js";
import { helpHint, helpLinkChip } from "../core/help.js";

export function renderDocsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  // Toolbar persists its search query in sessionStorage so navigating away
  // and back keeps the user's filter.
  const filter = (sessionStorage.getItem("docs.index.filter") || "").toLowerCase();
  const docs = (d.documents || []).filter(doc =>
    !filter
    || (doc.name || "").toLowerCase().includes(filter)
    || (doc.id || "").toLowerCase().includes(filter)
    || (doc.discipline || "").toLowerCase().includes(filter)
    || (doc.area || "").toLowerCase().includes(filter)
    || (doc.line || "").toLowerCase().includes(filter)
  );
  const uid = currentUserId();
  mount(root, [
    docsToolbar(filter),
    card(`Documents (${docs.length}${filter ? ` of ${(d.documents || []).length}` : ""})`, el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, ["Name","Discipline","Sensitivity","Current Rev","Revisions",""].map(h => el("th", {}, [h])))]),
      el("tbody", {}, docs.map(doc => {
        const rev = getById("revisions", doc.currentRevisionId);
        const ext = (doc.name?.split(".").pop() || rev?.blobName?.split(".").pop() || "").toLowerCase();
        const editable = ext === "xlsx" || ext === "xls";
        const canDelete = can("edit") || (doc.uploaderId && doc.uploaderId === uid);
        return el("tr", { class: "row-clickable", onClick: () => navigate(`/doc/${doc.id}`) }, [
          el("td", {}, [doc.name, el("div", { class: "tiny muted" }, [doc.id])]),
          el("td", {}, [badge(doc.discipline, "info")]),
          el("td", {}, [doc.sensitivity]),
          el("td", {}, [rev ? badge(`${rev.label} · ${rev.status}`, `rev-${rev.status.toLowerCase()}`) : "—"]),
          el("td", { class: "tiny muted" }, [String(doc.revisionIds?.length || 0)]),
          el("td", {}, [
            el("div", { class: "row" }, [
              el("button", {
                class: "btn sm",
                onClick: (e) => { e.stopPropagation(); navigate(`/doc/${doc.id}`); },
              }, ["Open"]),
              editable ? el("button", {
                class: "btn sm primary",
                title: "Open in the in-browser editor (Univer)",
                onClick: (e) => { e.stopPropagation(); navigate(`/edit/${doc.id}`); },
              }, ["Edit"]) : null,
              el("button", {
                class: "btn sm danger",
                disabled: !canDelete,
                title: canDelete ? "Delete document" : "Only the uploader or a user with edit permission can delete",
                onClick: (e) => { e.stopPropagation(); deleteDocument(doc); },
              }, ["Delete"]),
            ]),
          ]),
        ]);
      })),
    ])),
    docs.length === 0 && filter ? el("div", { class: "muted small mt-2" }, [`No documents match "${filter}".`]) : null,
    docsDropZone(),
  ]);
}

// Toolbar with native OS file-picker affordances. The hidden <input
// type="file"> element is the standard browser primitive that drives
// the OS file dialog (Finder on macOS, Files on Windows, Nautilus etc.
// on Linux). Clicking the visible button triggers the input.
function docsToolbar(currentFilter = "") {
  const fileInput = el("input", {
    type: "file",
    multiple: true,
    accept: ".pdf,.doc,.docx,.xls,.xlsx,.pptx,.dwg,.dxf,.ifc,.step,.stp,.iges,.igs,.stl,.obj,.gltf,.glb,.png,.jpg,.jpeg,.svg,.txt,.csv,.md",
    style: { display: "none" },
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) ingestFiles(Array.from(fileInput.files));
    fileInput.value = ""; // reset so re-selecting the same file fires
  });
  // Search box — filters docs by name / id / discipline / area / line in
  // real time. Persists in sessionStorage so the filter survives nav.
  const searchInput = el("input", {
    type: "search",
    class: "input",
    placeholder: "Search documents by name, id, discipline, area, line…",
    value: currentFilter,
    "aria-label": "Search documents",
    style: { minWidth: "320px" },
  });
  let debounceTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const v = /** @type {HTMLInputElement} */ (searchInput).value;
    debounceTimer = setTimeout(() => {
      if (v) sessionStorage.setItem("docs.index.filter", v);
      else sessionStorage.removeItem("docs.index.filter");
      renderDocsIndex();
      // Restore focus + cursor after re-render.
      setTimeout(() => {
        const fresh = document.querySelector('input[type="search"][aria-label="Search documents"]');
        if (fresh instanceof HTMLInputElement) {
          fresh.focus();
          try { fresh.setSelectionRange(v.length, v.length); } catch {}
        }
      }, 0);
    }, 120);
  });
  return el("div", { class: "row spread mb-3 gap-2" }, [
    el("div", {}, [
      el("h2", { style: { margin: 0, fontSize: "18px" } }, ["Documents"]),
      el("div", { class: "tiny muted" }, [
        "Drop files anywhere on this page or click ",
        el("span", { style: { fontWeight: 600 } }, ["Add document"]),
        " to use the system file picker.",
      ]),
    ]),
    el("div", { class: "row" }, [
      el("button", {
        class: "btn primary",
        onClick: () => fileInput.click(),
        title: "Open the system file picker (Finder / Files / Nautilus)",
      }, ["+ Add document"]),
      fileInput,
    ]),
  ]);
}

// Drop-zone overlay rendered at the bottom of the docs index. The
// page-level dragover handler turns this into a visible target while
// a drag is in progress; on drop, files are routed through ingestFiles.
function docsDropZone() {
  const zone = el("div", {
    class: "doc-drop-zone",
    "aria-label": "Drop files to add new documents",
  }, [
    el("div", { class: "doc-drop-icon", "aria-hidden": "true" }, ["⬇"]),
    el("div", { class: "doc-drop-title" }, ["Drop files anywhere to add documents"]),
    el("div", { class: "doc-drop-hint tiny muted" }, [
      "Supported: PDF, Office, CAD (DWG/DXF/IFC/STEP), images, CSV, Markdown.",
    ]),
  ]);

  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; zone.classList.add("is-active"); };
  const onDragLeave = () => zone.classList.remove("is-active");
  const onDrop = (e) => {
    e.preventDefault();
    zone.classList.remove("is-active");
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) ingestFiles(files);
  };
  // Bind to the screen container so dragging anywhere over the docs
  // list shows the drop affordance, not just the zone box itself.
  const sc = document.getElementById("screenContainer");
  if (sc) {
    sc.addEventListener("dragover", onDragOver);
    sc.addEventListener("dragleave", onDragLeave);
    sc.addEventListener("drop", onDrop);
  }
  return zone;
}

// Ingest one or more files dropped into the docs UI. We create a new
// Document + initial Revision in the local store, embed each file as a
// blob URL so the doc viewer can preview it, and navigate to the first
// new doc. In server mode this is where we'd POST to /api/files; for
// the offline / demo mode the blob URL is good enough to render.
async function ingestFiles(files) {
  if (!files.length) return;
  const ts = new Date().toISOString();
  const newDocs = [];
  for (const f of files) {
    const docId = "DOC-" + Math.random().toString(36).slice(2, 9).toUpperCase();
    const revId = "REV-" + Math.random().toString(36).slice(2, 9).toUpperCase();
    const url = URL.createObjectURL(f);
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const discipline = ext === "dwg" || ext === "dxf" || ext === "ifc" ? "Mechanical"
      : ext === "pdf" ? "Process" : ext === "csv" ? "Data" : "General";
    // Capture WHO uploaded so the metadata editor can grant edit
    // privileges back to the original uploader without requiring the
    // wider `edit` capability — matches the spec where the operator
    // who attached the file can keep tweaking discipline / package /
    // sensitivity until someone else takes over the document.
    const uid = currentUserId();
    const u = currentUser();
    const uploaderCtx = {
      userId: uid,
      name: u?.name || null,
      role: currentRole() || null,
      ts,
    };
    const doc = {
      id: docId,
      name: f.name,
      discipline,
      sensitivity: "internal",
      currentRevisionId: revId,
      revisionIds: [revId],
      teamSpaceId: state.data?.teamSpaces?.[0]?.id || null,
      projectId: null,
      acl: {},
      labels: ["uploaded"],
      uploaderId: uid,
      uploaderContext: uploaderCtx,
      // Use camelCase consistently — the doc viewer reads `createdAt`
      // / `updatedAt` everywhere (matches the seed shape). Snake_case
      // here would surface as `Invalid Date` in metadata + revision
      // banner + transmittal templates.
      createdAt: ts,
      updatedAt: ts,
    };
    const rev = {
      id: revId,
      docId,
      label: "A",
      status: "Draft",
      summary: "Initial upload",
      notes: `Uploaded ${f.name} (${Math.round(f.size / 1024)} KB)`,
      pdfUrl: url,
      blobName: f.name,
      blobType: f.type,
      blobSize: f.size,
      // Mirror the file's MIME type into `assetMime` so the PDF / image
      // / CSV detector picks it up — the renderer keys off `assetMime`,
      // and a blob: URL has no extension to fall back on.
      assetMime: f.type || guessMime(f.name) || "",
      uploaderId: uid,
      uploaderContext: uploaderCtx,
      createdAt: ts,
      updatedAt: ts,
    };
    newDocs.push({ doc, rev });
  }
  update(s => {
    s.data.documents = s.data.documents || [];
    s.data.revisions = s.data.revisions || [];
    for (const { doc, rev } of newDocs) {
      s.data.documents.push(doc);
      s.data.revisions.push(rev);
    }
  });
  for (const { doc } of newDocs) {
    audit("document.upload", doc.id, { name: doc.name, via: "file-picker" });
  }
  toast(`${newDocs.length} document${newDocs.length === 1 ? "" : "s"} added`, "success");
  navigate(`/doc/${newDocs[0].doc.id}`);
}

const SK = (id, k) => `doc.${id}.${k}`;
const PAGES = 3; // Each document has 3 "paper" pages for demonstration.

export function renderDocViewer({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const doc = getById("documents", id);
  if (!doc) return mount(root, el("div", { class: "muted" }, ["Document not found."]));

  const activeRevId = sessionStorage.getItem(SK(id, "rev")) || doc.currentRevisionId;
  const rev = getById("revisions", activeRevId) || getById("revisions", doc.currentRevisionId);
  const activePage = parseInt(sessionStorage.getItem(SK(id, "page")) || "1", 10);

  mount(root, [
    revisionSafetyBanner(doc, rev),
    metadataBar(doc, rev),
    el("div", { class: "viewer-layout" }, [
      canvasArea(doc, rev, activePage),
      sidePane(doc, rev),
    ]),
  ]);
}

function revisionSafetyBanner(doc, rev) {
  const isCurrent = doc.currentRevisionId === rev.id;
  const status = rev.status || "Unknown";
  const variant = status === "Rejected" || (!isCurrent && status === "Superseded") ? "danger"
    : status === "IFC" || status === "Approved" ? "success"
    : status === "IFR" ? "info"
    : "warn";
  const stateLabel = !isCurrent
    ? `Viewing historical revision ${rev.label}`
    : status === "Superseded"
      ? `Current pointer is superseded: Rev ${rev.label}`
      : `Rev ${rev.label} is ${status}`;
  const guidance = !isCurrent
    ? "Do not approve, issue, or build from this revision until you compare it with the current revision."
    : status === "IFC"
      ? "Issued for construction. Confirm downstream work and transmittals before acting."
      : status === "Approved"
        ? "Approved but not necessarily issued. Review transmittals before external release."
        : status === "Rejected"
          ? "Rejected revision. Rework is required before approval or issue."
          : status === "IFR"
            ? "In review. Resolve comments and approvals before issue."
            : "Draft or preliminary revision. Treat as controlled work in progress.";
  return el("section", { class: `revision-safety-banner ${variant}`, "aria-live": "polite" }, [
    el("div", { class: "revision-safety-main" }, [
      el("div", { class: "revision-safety-kicker" }, ["Document control"]),
      el("div", { class: "revision-safety-title", style: { display: "inline-flex", alignItems: "center" } }, [doc.name, helpHint("forge.document")]),
      el("div", { class: "revision-safety-state" }, [stateLabel]),
      el("div", { class: "revision-safety-guidance" }, [guidance]),
      el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
        helpLinkChip("forge.doc.revisions", "Revision lifecycle"),
        helpLinkChip("forge.doc.transmittal", "Transmittals"),
        helpLinkChip("forge.doc.regional-comments", "Regional comments"),
        helpLinkChip("forge.doc.metadata", "Metadata fields"),
      ]),
    ]),
    el("div", { class: "revision-safety-actions" }, [
      badge(status, revVariant(status)),
      isCurrent ? null : el("button", {
        class: "btn sm",
        onClick: () => {
          sessionStorage.setItem(SK(doc.id, "rev"), doc.currentRevisionId);
          renderDocViewer({ id: doc.id });
        },
      }, ["Open current"]),
      el("button", { class: "btn sm", onClick: () => navigate(`/compare/${rev.id}/${pickOther(doc, rev)}`) }, ["Compare"]),
      el("button", { class: "btn sm primary", disabled: !can("approve"), onClick: () => navigate("/approvals") }, ["Review approvals"]),
    ]),
  ]);
}

function metadataBar(doc, rev) {
  // Delete is gated to either the original uploader OR anyone with the
  // `edit` capability — same model as the metadata editor. Genuine
  // controlled-document regimes would route this through an Archive
  // workflow instead of a hard delete; the demo model uses
  // soft-deletion (the doc is removed from state.data.documents and
  // its revisions are no longer referenced) and audits the action.
  const uid = currentUserId();
  const canDelete = can("edit") || (doc.uploaderId && doc.uploaderId === uid);
  return el("div", { class: "row spread mb-3" }, [
    el("div", { class: "row wrap" }, [
      badge(doc.id, "info"),
      badge(doc.discipline || "—", "info"),
      badge(`Rev ${rev.label}`, `rev-${rev.status.toLowerCase()}`),
      badge(rev.status, revVariant(rev.status)),
      badge(doc.sensitivity || "—", "warn"),
      el("span", { class: "tiny muted" }, [`Effective ${new Date(rev.createdAt || rev.created_at || Date.now()).toLocaleDateString()}`]),
    ]),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm", onClick: () => followToggle(doc.id) }, [isFollowing(doc.id) ? "Unfollow" : "Follow"]),
      el("button", {
        class: "btn sm danger",
        disabled: !canDelete,
        title: canDelete ? "Delete this document" : "Only the uploader or a user with edit permission can delete",
        onClick: () => deleteDocument(doc),
      }, ["Delete"]),
    ]),
  ]);
}

function followToggle(docId) {
  if (isFollowing(docId)) unfollow(docId); else follow(docId);
  renderDocViewer({ id: docId });
}

async function deleteDocument(doc) {
  const uid = currentUserId();
  const canDelete = can("edit") || (doc.uploaderId && doc.uploaderId === uid);
  if (!canDelete) {
    toast("Only the uploader or a user with edit permission can delete this document", "warn");
    return;
  }
  const ok = await confirm({
    title: `Delete ${doc.name}?`,
    message: `Permanently remove "${doc.name}" and all its revisions? This is recorded in the audit ledger and cannot be undone from the UI.`,
    confirmLabel: "Delete",
    variant: "danger",
  });
  if (!ok) return;
  const revIds = (doc.revisionIds || []).slice();
  update(s => {
    s.data.documents = (s.data.documents || []).filter(x => x.id !== doc.id);
    s.data.revisions = (s.data.revisions || []).filter(r => !revIds.includes(r.id));
    s.data.comments  = (s.data.comments  || []).filter(c => c.docId !== doc.id);
    s.data.docAnnotations = (s.data.docAnnotations || []).filter(a => a.docId !== doc.id);
  });
  audit("document.delete", doc.id, { name: doc.name, revisionCount: revIds.length });
  toast(`${doc.name} deleted`, "success");
  navigate("/docs");
}

function revVariant(status) {
  return ({
    "Draft":"warn","IFR":"info","Approved":"success","IFC":"accent","Superseded":"warn","Archived":"","Rejected":"danger",
  })[status] || "";
}

function pickOther(doc, rev) {
  const ids = doc.revisionIds || [];
  const idx = ids.indexOf(rev.id);
  return ids[idx - 1] || ids[idx + 1] || rev.id;
}

// Rich viewer chrome — modeled after the EmbedPDF / Adobe Acrobat layout
// the operator team asked for. Top row carries page nav + zoom controls
// + persistent doc actions; the mode bar switches the viewer between
// View / Annotate / Shapes / Insert / Form / Redact; when Annotate is
// active a sub-toolbar exposes the actual annotation tools.
//
// State that survives a re-render lives in sessionStorage keyed by
// doc id (same convention used for active page / active revision).

const VIEWER_MODES = [
  { id: "view",     label: "View" },
  { id: "annotate", label: "Annotate" },
  { id: "shapes",   label: "Shapes" },
  { id: "insert",   label: "Insert" },
  { id: "form",     label: "Form" },
  { id: "redact",   label: "Redact" },
];

const ANNOTATE_TOOLS = [
  { id: "comment",   label: "Sticky note", icon: "🗨", impl: true },
  { id: "highlight", label: "Highlight",   icon: "🖍", impl: true },
  { id: "underline", label: "Underline",   icon: "U̲", impl: true },
  { id: "strike",    label: "Strikethrough", icon: "S̶", impl: true },
  { id: "draw",      label: "Free draw",   icon: "✎", impl: true },
];

const SHAPE_TOOLS = [
  { id: "rect",    label: "Rectangle", icon: "▭" },
  { id: "ellipse", label: "Ellipse",   icon: "◯" },
  { id: "line",    label: "Line",      icon: "—" },
  { id: "arrow",   label: "Arrow",     icon: "→" },
];

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function getMode(docId)  { return sessionStorage.getItem(SK(docId, "mode")) || "view"; }
function getZoom(docId)  { return parseFloat(sessionStorage.getItem(SK(docId, "zoom")) || "1.25"); }
function getTool(docId)  { return sessionStorage.getItem(SK(docId, "tool")) || "comment"; }
function setMode(docId, m) { sessionStorage.setItem(SK(docId, "mode"), m); renderDocViewer({ id: docId }); }
function setZoom(docId, z) { sessionStorage.setItem(SK(docId, "zoom"), String(z)); renderDocViewer({ id: docId }); }
function setTool(docId, t) { sessionStorage.setItem(SK(docId, "tool"), t); renderDocViewer({ id: docId }); }

function canvasArea(doc, rev, activePage) {
  const mode = getMode(doc.id);
  const zoom = getZoom(doc.id);
  return el("div", { class: "viewer-canvas" }, [
    viewerTopBar(doc, rev, activePage, zoom),
    viewerModeBar(doc, mode),
    mode === "annotate" ? viewerAnnotateBar(doc) : null,
    mode === "shapes"   ? viewerShapesBar(doc)   : null,
    mode === "redact"   ? viewerRedactBar(doc)   : null,
    mode === "insert"   ? viewerInsertBar(doc)   : null,
    mode === "form"     ? viewerFormBar(doc)     : null,
    el("div", { class: `viewer-page mode-${mode}`, id: `paper-${doc.id}` }, [
      paperPage(doc, rev, activePage, { zoom, mode }),
    ]),
    pageStrip(doc, activePage),
  ]);
}

function viewerTopBar(doc, rev, activePage, zoom) {
  const pct = Math.round(zoom * 100);
  return el("div", { class: "viewer-toolbar" }, [
    // Page navigation
    el("button", {
      class: "btn sm icon-btn",
      title: "Previous page",
      "aria-label": "Previous page",
      disabled: activePage <= 1,
      onClick: () => goPage(doc.id, activePage - 1),
    }, ["◀"]),
    el("span", { class: "tiny mono", style: { minWidth: "60px", textAlign: "center" } }, [`${activePage} / ${PAGES}`]),
    el("button", {
      class: "btn sm icon-btn",
      title: "Next page",
      "aria-label": "Next page",
      disabled: activePage >= PAGES,
      onClick: () => goPage(doc.id, activePage + 1),
    }, ["▶"]),
    el("span", { class: "viewer-toolbar-divider", "aria-hidden": "true" }),
    // Zoom
    el("button", {
      class: "btn sm icon-btn",
      title: "Zoom out",
      "aria-label": "Zoom out",
      disabled: zoom <= ZOOM_LEVELS[0],
      onClick: () => setZoom(doc.id, prevZoom(zoom)),
    }, ["−"]),
    el("span", { class: "tiny mono", style: { minWidth: "52px", textAlign: "center" } }, [`${pct}%`]),
    el("button", {
      class: "btn sm icon-btn",
      title: "Zoom in",
      "aria-label": "Zoom in",
      disabled: zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1],
      onClick: () => setZoom(doc.id, nextZoom(zoom)),
    }, ["+"]),
    el("button", {
      class: "btn sm",
      title: "Fit width",
      onClick: () => setZoom(doc.id, 1.5),
    }, ["Fit width"]),
    el("button", {
      class: "btn sm",
      title: "Fit page",
      onClick: () => setZoom(doc.id, 0.85),
    }, ["Fit page"]),
    el("span", { style: { flex: 1 } }),
    // Persistent doc actions on the right
    el("button", { class: "btn sm", onClick: () => draftTransmittal(doc, rev) }, ["Transmittal"]),
    el("button", { class: "btn sm", onClick: () => attachPdf(doc, rev) }, [rev.pdfUrl ? "Change PDF" : "Attach PDF"]),
  ]);
}

function viewerModeBar(doc, activeMode) {
  return el("div", { class: "viewer-modebar", role: "tablist", "aria-label": "Viewer mode" },
    VIEWER_MODES.map(m => el("button", {
      class: `viewer-mode-btn ${activeMode === m.id ? "active" : ""}`,
      role: "tab",
      "aria-selected": activeMode === m.id ? "true" : "false",
      onClick: () => setMode(doc.id, m.id),
    }, [m.label]))
  );
}

function viewerAnnotateBar(doc) {
  const tool = getTool(doc.id);
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Annotation tools" }, [
    ...ANNOTATE_TOOLS.map(t => el("button", {
      class: `viewer-tool-btn ${tool === t.id ? "active" : ""}`,
      title: t.label,
      "aria-label": t.label,
      onClick: () => setTool(doc.id, t.id),
    }, [
      el("span", { class: "viewer-tool-icon", "aria-hidden": "true" }, [t.icon]),
      el("span", { class: "viewer-tool-label" }, [t.label]),
    ])),
    el("span", { class: "tiny muted ml-2" }, [
      tool === "comment" ? "Click on the page to drop a sticky note."
      : tool === "draw"  ? "Click + drag to draw freehand."
      : "Click + drag across the text to mark.",
    ]),
  ]);
}

function viewerShapesBar(doc) {
  const tool = getShapeTool(doc.id);
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Shape tools" }, [
    ...SHAPE_TOOLS.map(t => el("button", {
      class: `viewer-tool-btn ${tool === t.id ? "active" : ""}`,
      title: t.label,
      "aria-label": t.label,
      onClick: () => setShapeTool(doc.id, t.id),
    }, [
      el("span", { class: "viewer-tool-icon", "aria-hidden": "true" }, [t.icon]),
      el("span", { class: "viewer-tool-label" }, [t.label]),
    ])),
    el("span", { class: "tiny muted ml-2" }, ["Click + drag to draw the shape. Double-click any shape to delete."]),
  ]);
}

function viewerRedactBar(doc) {
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Redaction" }, [
    el("span", { class: "tiny" }, [
      "Click + drag to mark a region for redaction. The reason you provide is recorded in the audit ledger. ",
      "Visual redaction in the viewer; bake-into-PDF on export is a separate slice.",
    ]),
  ]);
}

function viewerInsertBar(doc) {
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Insert" }, [
    el("span", { class: "tiny" }, ["Click anywhere on the page to drop a text annotation. Double-click any annotation to delete."]),
  ]);
}

function viewerFormBar(doc) {
  return el("div", { class: "viewer-annotate-bar", role: "toolbar", "aria-label": "Form fields" }, [
    el("span", { class: "tiny" }, ["Click + drag to place a fillable field. You'll be prompted for a label and a default value."]),
  ]);
}

function getShapeTool(docId) { return sessionStorage.getItem(SK(docId, "shapeTool")) || "rect"; }
function setShapeTool(docId, t) { sessionStorage.setItem(SK(docId, "shapeTool"), t); renderDocViewer({ id: docId }); }

/**
 * Drop the annotation SVG overlay on top of a rendered PDF / image
 * canvas. Sized to match the host so coordinates [0..1] line up with
 * the rendered page. Re-mounts cleanly whenever the page is re-
 * rendered (zoom change, mode change, page nav).
 */
function mountAnnotationOverlay(host, doc, rev, page, mode) {
  const tool = mode === "shapes" ? getShapeTool(doc.id) : getTool(doc.id);
  const author = currentUser()?.name || currentUser()?.id || currentRole() || "anonymous";
  // Make the host a positioning context so the absolute-positioned
  // overlay aligns to the rendered canvas/image.
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const overlay = buildAnnotationOverlay({
    docId: doc.id, revId: rev.id, page,
    mode, tool, author,
    onChanged: () => renderDocViewer({ id: doc.id }),
  });
  host.append(overlay);
}

function prevZoom(z) {
  const i = ZOOM_LEVELS.findIndex(l => l >= z);
  return i <= 0 ? ZOOM_LEVELS[0] : ZOOM_LEVELS[i - 1];
}
function nextZoom(z) {
  const i = ZOOM_LEVELS.findIndex(l => l > z);
  return i === -1 ? ZOOM_LEVELS[ZOOM_LEVELS.length - 1] : ZOOM_LEVELS[i];
}

function paperPage(doc, rev, page, opts = {}) {
  const zoom = opts.zoom || 1.25;
  const mode = opts.mode || "view";
  const comments = (state.data.comments || []).filter(c => c.docId === doc.id && c.revId === rev.id && c.page === page);
  const container = el("div", { class: `paper paper-mode-${mode}` }, [
    el("h2", {}, [`${doc.name} — page ${page}`]),
    el("div", { class: "paper-meta" }, [`${doc.id}  ·  Rev ${rev.label} ${rev.status}  ·  ${new Date(rev.createdAt || rev.created_at || Date.now()).toLocaleDateString()}`]),
    paperContent(doc, rev, page),
    ...comments.map(c => commentPin(c)),
  ]);

  // Every mode now renders the underlying PDF + an SVG annotation
  // overlay sized 1:1 with the canvas. The overlay's pointer wiring
  // is mode-specific (handled in `pdfAnnotations.js`), so the PDF
  // doesn't need to be re-rendered when switching modes.

  // If the revision has an attached URL, pick the renderer by content kind.
  // CAD formats (DWG/DXF/STEP/IGES/STL/OBJ/glTF/3DM/3DS/3MF/FBX/DAE/PLY/IFC/...)
  // are routed to the unified CAD viewer; PDF/image/CSV stay on their
  // existing renderers.
  const url = rev.pdfUrl || rev.assetUrl || null;
  // Fall through `assetMime || blobType || blobName-derived` so blob URLs
  // (which have no extension to sniff) still get routed to the right
  // renderer. The blobName-derived fallback covers older docs uploaded
  // before we started populating `assetMime`.
  const effectiveMime = rev.assetMime || rev.blobType || guessMime(rev.blobName || "");
  const cadKind = detectCad(url, effectiveMime);
  if (url && cadKind && cadKind.viewer !== "image" && cadKind.viewer !== "pdf" && cadKind.viewer !== "csv") {
    const host = document.createElement("div");
    host.style.minHeight = "70vh";
    container.replaceChildren(host);
    renderCad(host, { url, name: rev.blobName || url, mime: effectiveMime }).catch(() => {});
    for (const c of comments) container.append(commentPin(c));
    return container;
  }
  const kind = detectKind(url, effectiveMime);
  if (url && kind) {
    const host = document.createElement("div");
    host.className = "asset-host";
    host.style.minHeight = "420px";
    // UX-D: hand-rolled "Loading…" textContent replaced with the
    // shared loadingState() primitive so screen-readers announce
    // the busy state and the visual treatment matches the rest of
    // the app. Subsequent error/success branches still mutate
    // host content so the contract is unchanged.
    host.replaceChildren(loadingState({ message: "Loading document…" }));
    // UX-G: defer the heavy viewer kickoff (PDF.js / CSV parser) to
    // the next idle period so the screen shell paints first. The
    // loadingState() above gives the user immediate feedback while
    // the browser finishes layout. Image previews stay synchronous —
    // they're cheap and a deferred image load looks like a bug.
    const startRender = async () => {
      try {
        if (kind === "pdf") {
          const pdf = await openPdf(url);
          if (!pdf) { host.textContent = "PDF.js unavailable — showing placeholder."; return; }
          // Zoom is the user's chosen scale from the toolbar. Pages are
          // capped at the PDF's actual page count so stale page indices
          // (after switching from a 5-page doc to a 2-page doc) still
          // render the last available page instead of erroring.
          await renderPage(pdf, Math.min(page, pdf.numPages), host, { scale: zoom });
          mountAnnotationOverlay(host, doc, rev, page, mode);
        } else if (kind === "image") {
          host.replaceChildren(el("img", { src: url, alt: doc.name + " — page " + page, style: { maxWidth: "100%", border: "1px solid var(--border)", borderRadius: "6px", background: "#fff" } }));
          mountAnnotationOverlay(host, doc, rev, page, mode);
        } else if (kind === "csv") {
          const text = await fetch(url).then(r => r.text()).catch(() => null);
          if (!text) { host.textContent = "Failed to load CSV."; return; }
          const parsed = await parseCSV(text);
          host.replaceChildren(renderCsvTable(parsed));
        }
      } catch (e) {
        host.textContent = "Failed to render: " + e.message;
      }
    };
    if (kind === "image") {
      // No deferral — keep the synchronous flow.
      startRender();
    } else {
      // PDF + CSV go through the idle scheduler. 250ms hard deadline
      // so a preview that the user is actively waiting for never
      // stalls behind a busy main thread.
      idle(startRender, { timeout: 250 });
    }
    container.replaceChildren(host);
    for (const c of comments) container.append(commentPin(c));
  }

  container.addEventListener("click", (e) => {
    if (!can("create")) return;
    // In Annotate mode with the sticky-note tool active, a plain click
    // drops a pin (no modifier required). In every other mode hold
    // Alt to drop one — same as before, so existing muscle memory
    // keeps working from the View tab.
    const annotateClick = mode === "annotate" && getTool(doc.id) === "comment";
    if (!annotateClick && !e.altKey) return;
    const rect = container.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    addCommentPin(doc.id, rev.id, page, x, y);
  });

  return container;
}

function paperContent(doc, rev, page) {
  const body = ({
    1: [
      el("p", {}, [rev.summary || "This revision introduces engineering changes summarized in the metadata panel."]),
      el("p", {}, [
        "The FORGE document viewer anchors regional comments to normalized (page, x, y) coordinates so ",
        "pinned discussions remain accurate across re-flows. Alt-click anywhere to drop a pin on this page."
      ]),
      el("p", { class: "muted tiny" }, ["Notes: ", rev.notes || "(none)"]),
    ],
    2: [
      el("h3", {}, ["Scope"]),
      el("p", {}, ["Scope of this revision covers the assets and packages listed in the metadata panel to the right. ",
        "Impacted items are automatically computed from the revision graph (see Impact below)."]),
    ],
    3: [
      el("h3", {}, ["Approval history"]),
      el("p", {}, ["Approval routing is managed from the /approvals screen. Transmittals record outbound issuance of IFC revisions."]),
    ],
  })[page] || [];
  return el("div", {}, body);
}

function commentPin(c) {
  const pin = el("div", {
    class: "markup-pin",
    style: { left: (c.x * 100) + "%", top: (c.y * 100) + "%" },
    title: c.text,
    onClick: (e) => { e.stopPropagation(); openComment(c); },
  }, [String(c.seq || "•")]);
  return pin;
}

function pageStrip(doc, activePage) {
  return el("div", { class: "row", style: { padding: "8px", gap: "8px", borderTop: "1px solid var(--border)" } },
    Array.from({ length: PAGES }, (_, i) => el("button", {
      class: `btn sm ${i + 1 === activePage ? "primary" : ""}`,
      onClick: () => goPage(doc.id, i + 1),
    }, [`p${i + 1}`]))
  );
}

function goPage(docId, p) {
  sessionStorage.setItem(SK(docId, "page"), String(p));
  renderDocViewer({ id: docId });
}

function sidePane(doc, rev) {
  const d = state.data;
  const docTransmittals = (d.transmittals || []).filter(t => t.docId === doc.id);
  return el("div", { class: "viewer-side" }, [
    metadataCard(doc, rev),
    revisionTimelineCard(doc, rev),
    approvalsCard(doc, rev),
    commentsCard(doc, rev),
    transmittalsCard(doc, docTransmittals),
    impactCard(rev),
    crossLinks(doc),
    askCard(doc, rev),
  ]);
}

function metadataCard(doc, rev) {
  const projects = state.data?.projects || [];
  const projectName = projects.find(p => p.id === doc.projectId)?.name || doc.projectId || "—";
  const effective = rev.createdAt ? new Date(rev.createdAt || rev.created_at || Date.now()).toLocaleDateString() : "—";
  const meta = [
    ["Discipline", doc.discipline],
    ["Project", projectName],
    ["Package", doc.package || "—"],
    ["Area", doc.area || "—"],
    ["Line", doc.line || "—"],
    ["System", doc.system || "—"],
    ["Vendor", doc.vendor || "—"],
    ["Sensitivity", doc.sensitivity],
    ["Revision", `${rev.label} · ${rev.status}`],
    ["Approver", rev.approverId || "—"],
    ["Effective", effective],
  ];
  // Permission: anyone with the `edit` capability OR the original
  // uploader of this doc. The latter avoids forcing an admin pass to
  // correct e.g. discipline tags right after a drag-drop upload.
  const uid = currentUserId();
  const canEdit = can("edit") || (doc.uploaderId && doc.uploaderId === uid);
  return card("Metadata", el("div", { class: "stack" }, [
    ...meta.map(([k, v]) =>
      el("div", { class: "row" }, [
        el("span", { class: "tiny muted", style: { width: "90px" } }, [k]),
        el("span", { class: "small" }, [String(v || "—")]),
      ])
    ),
    el("div", { class: "row mt-2" }, [
      el("button", {
        class: "btn sm",
        disabled: !canEdit,
        title: canEdit ? "Edit document metadata" : "You need edit permission or to be the uploader",
        onClick: () => openMetadataEditor(doc, rev),
      }, ["Edit metadata"]),
    ]),
  ]));
}

// Metadata editor — modal form scoped to the editable doc-level fields.
// Revision-level fields (`label`, `status`, `approverId`) are deliberately
// NOT here: they belong to the approval / revision-bump flow and editing
// them ad-hoc would bypass the audit chain that controlled-document
// regimes (ISO 9001, PED, ASME) require.
function openMetadataEditor(doc, rev) {
  const uid = currentUserId();
  const canEdit = can("edit") || (doc.uploaderId && doc.uploaderId === uid);
  if (!canEdit) {
    toast("Only the uploader or someone with edit permission can change metadata", "warn");
    return;
  }

  const projects = state.data?.projects || [];
  const projectOptions = [
    { value: "", label: "— (none) —" },
    ...projects.map(p => ({ value: p.id, label: p.name })),
  ];
  const sensitivityOptions = [
    { value: "public",       label: "Public" },
    { value: "internal",     label: "Internal" },
    { value: "restricted",   label: "Restricted" },
    { value: "confidential", label: "Confidential" },
  ];
  const disciplineOptions = [
    { value: "Process",     label: "Process" },
    { value: "Mechanical",  label: "Mechanical" },
    { value: "Electrical",  label: "Electrical" },
    { value: "Instrumentation", label: "Instrumentation" },
    { value: "Civil",       label: "Civil" },
    { value: "Structural",  label: "Structural" },
    { value: "Controls",    label: "Controls" },
    { value: "Data",        label: "Data" },
    { value: "General",     label: "General" },
  ];

  // Autocomplete suggestion sets — collected from values already in the
  // workspace so operators don't have to retype "Line A" 200 times. The
  // user can still type a new value (datalist preserves free entry); the
  // suggestion list just makes the common case one click. Sources:
  //  - existing `documents.{package, area, line, system, vendor}` fields
  //  - tokens parsed from `assets.hierarchy` strings
  //    (e.g. "North Plant > Line A > Cell-3 > HX-01")
  //  - asset `name` segments split on "/" (older naming convention)
  const suggestions = collectMetadataSuggestions(state.data || {});

  const nameInput        = input({ value: doc.name || "" });
  const disciplineSelect = select(disciplineOptions, { value: doc.discipline || "General" });
  const projectSelect    = select(projectOptions,   { value: doc.projectId || "" });
  const packageWrap      = inputWithSuggestions(suggestions.package, { value: doc.package || "", placeholder: "e.g. Package 3" });
  const areaWrap         = inputWithSuggestions(suggestions.area,    { value: doc.area    || "", placeholder: "e.g. Area 200, North Plant" });
  const lineWrap         = inputWithSuggestions(suggestions.line,    { value: doc.line    || "", placeholder: "e.g. Line A, Line B" });
  const systemWrap       = inputWithSuggestions(suggestions.system,  { value: doc.system  || "", placeholder: "e.g. Cooling, Steam, Feeder" });
  const vendorWrap       = inputWithSuggestions(suggestions.vendor,  { value: doc.vendor  || "", placeholder: "e.g. Siemens, ABB" });
  const sensitivitySel   = select(sensitivityOptions, { value: doc.sensitivity || "internal" });

  /** @type {(w: any) => string} */
  const wrapVal = (w) => String((w?.input?.value) || "").trim();

  const save = () => {
    const next = {
      name:        String(/** @type {HTMLInputElement} */ (nameInput).value || "").trim() || doc.name,
      discipline:  String(/** @type {HTMLSelectElement} */ (disciplineSelect).value || ""),
      projectId:   String(/** @type {HTMLSelectElement} */ (projectSelect).value || "") || null,
      package:     wrapVal(packageWrap),
      area:        wrapVal(areaWrap),
      line:        wrapVal(lineWrap),
      system:      wrapVal(systemWrap),
      vendor:      wrapVal(vendorWrap),
      sensitivity: String(/** @type {HTMLSelectElement} */ (sensitivitySel).value || "internal"),
    };
    update(s => {
      const target = (s.data.documents || []).find(x => x.id === doc.id);
      if (!target) return;
      Object.assign(target, next);
      target.updatedAt = new Date().toISOString();
    });
    audit("document.metadata.edit", doc.id, { changedTo: next });
    toast("Metadata saved", "success");
    renderDocViewer({ id: doc.id });
    return true;
  };

  modal({
    title: `Edit metadata · ${doc.name}`,
    body: el("div", { class: "stack" }, [
      formRow("Name",        nameInput),
      formRow("Discipline",  disciplineSelect),
      formRow("Project",     projectSelect),
      formRow("Package",     packageWrap),
      formRow("Area",        areaWrap),
      formRow("Line",        lineWrap),
      formRow("System",      systemWrap),
      formRow("Vendor",      vendorWrap),
      formRow("Sensitivity", sensitivitySel),
      el("div", { class: "tiny muted" }, [
        "Package / Area / Line / System / Vendor autocomplete from existing assets and documents in this workspace — type to filter, or enter a new value.",
      ]),
      el("div", { class: "tiny muted" }, [
        "Revision label, status, and approver are managed via the approval flow — not here. ",
        "All edits are recorded in the audit ledger.",
      ]),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: save },
    ],
  });
}

/**
 * Build autocomplete suggestion lists for metadata fields, sourced from
 * what's already in the workspace.
 *
 * @param {any} d state.data
 * @returns {{ package: string[], area: string[], line: string[], system: string[], vendor: string[] }}
 */
function collectMetadataSuggestions(d) {
  /** @type {{ package: Set<string>, area: Set<string>, line: Set<string>, system: Set<string>, vendor: Set<string> }} */
  const buckets = {
    package: new Set(),
    area:    new Set(),
    line:    new Set(),
    system:  new Set(),
    vendor:  new Set(),
  };
  // Pull from existing documents — values that someone has already used.
  for (const x of (d.documents || [])) {
    if (x.package) buckets.package.add(String(x.package));
    if (x.area)    buckets.area.add(String(x.area));
    if (x.line)    buckets.line.add(String(x.line));
    if (x.system)  buckets.system.add(String(x.system));
    if (x.vendor)  buckets.vendor.add(String(x.vendor));
  }
  // Parse asset hierarchy strings (e.g. "North Plant > Line A > Cell-3
  // > HX-01") and asset names (e.g. "Line A / Cell-1 / Feeder A1") to
  // surface plausible Area/Line/System candidates. Heuristic: tokens
  // starting with "Line", "Area", "Cell", "Site", "Building" go to
  // their matching bucket; everything else gets offered as Area too,
  // since real-world hierarchies vary.
  for (const a of (d.assets || [])) {
    const tokens = [];
    if (a.hierarchy) tokens.push(...String(a.hierarchy).split(/\s*[>\\/]\s*/));
    if (a.name)      tokens.push(...String(a.name).split(/\s*[>\\/]\s*/));
    for (const t0 of tokens) {
      const t = t0.trim();
      if (!t || t.length < 2) continue;
      if (/^line\b/i.test(t))     buckets.line.add(t);
      else if (/^area\b/i.test(t)) buckets.area.add(t);
      else if (/^(cell|unit|skid)\b/i.test(t)) buckets.system.add(t);
      else if (/^(site|plant|building|hq)\b/i.test(t)) buckets.area.add(t);
      // Don't pollute the suggestions with tag IDs like "HX-01" /
      // "Feeder A1" — those are asset-specific, not Area/Line/System.
    }
    if (a.vendor)  buckets.vendor.add(String(a.vendor));
    if (a.system)  buckets.system.add(String(a.system));
    if (a.package) buckets.package.add(String(a.package));
  }
  return {
    package: Array.from(buckets.package),
    area:    Array.from(buckets.area),
    line:    Array.from(buckets.line),
    system:  Array.from(buckets.system),
    vendor:  Array.from(buckets.vendor),
  };
}

function revisionTimelineCard(doc, rev) {
  const ids = doc.revisionIds || [];
  return card("Revision timeline", el("div", { class: "revision-timeline" },
    ids.map(rid => {
      const r = getById("revisions", rid);
      if (!r) return null;
      const label = r.status === "Superseded" ? `${r.label} · superseded` : `${r.label} · ${r.status}`;
      return el("div", {
        class: `revision-row ${r.id === rev.id ? "active" : ""}`,
        onClick: () => { sessionStorage.setItem(SK(doc.id, "rev"), r.id); renderDocViewer({ id: doc.id }); },
      }, [
        badge(`Rev ${r.label}`, `rev-${r.status.toLowerCase()}`),
        el("div", {}, [
          el("div", { class: "small" }, [label]),
          el("div", { class: "tiny muted" }, [new Date(r.createdAt).toLocaleDateString()]),
        ]),
      ]);
    })
  ));
}

function approvalsCard(doc, rev) {
  const list = (state.data.approvals || []).filter(a => a.subject?.kind === "Revision" && a.subject?.id === rev.id);
  return card("Approvals", el("div", { class: "stack" }, [
    ...list.map(a => el("div", { class: "row wrap" }, [
      badge(a.status, a.status === "approved" ? "success" : a.status === "rejected" ? "danger" : "warn"),
      el("span", { class: "small" }, [a.id]),
      a.signedAt ? el("span", { class: "tiny muted" }, ["signed " + new Date(a.signedAt).toLocaleString()]) : null,
    ])),
    list.length === 0 ? el("div", { class: "muted tiny" }, ["None"]) : null,
    el("div", { class: "row" }, [
      el("button", { class: "btn sm", onClick: () => navigate("/approvals") }, ["Queue →"]),
    ]),
  ]));
}

function commentsCard(doc, rev) {
  const comments = (state.data.comments || []).filter(c => c.docId === doc.id && c.revId === rev.id);
  return card(`Regional comments (${comments.length})`, el("div", { class: "stack" }, [
    comments.length
      ? comments.map(c => el("button", { class: "activity-row", type: "button", onClick: () => openComment(c) }, [
          el("span", { class: "ts" }, [`p${c.page} #${c.seq}`]),
          el("span", { class: "small" }, [c.text || ""]),
          el("span", { class: "tiny muted" }, [c.author]),
        ]))
      : [el("div", { class: "muted tiny" }, ["No pinned comments on this revision."])],
    el("div", { class: "tiny muted" }, ["Alt-click the page to drop a pin."]),
  ]));
}

function transmittalsCard(doc, list) {
  return card(`Transmittals (${list.length})`, el("div", { class: "stack" }, [
    ...list.map(t => el("div", { class: "activity-row" }, [
      badge("T", "accent"),
      el("div", { class: "stack", style: { gap: "2px", flex: 1 } }, [
        el("span", { class: "small" }, [t.subject]),
        el("span", { class: "tiny muted" }, [`To ${t.recipients.join(", ")} · ${new Date(t.ts).toLocaleDateString()}`]),
      ]),
    ])),
    list.length === 0 ? el("div", { class: "muted tiny" }, ["No transmittals yet."]) : null,
    el("div", { class: "row" }, [
      el("button", { class: "btn sm primary", onClick: () => draftTransmittal(doc, getById("revisions", doc.currentRevisionId)) }, ["+ Transmittal"]),
    ]),
  ]));
}

function impactCard(rev) {
  const impact = impactOfRevision(rev.id);
  return card("AI — Impact analysis", el("div", { class: "stack" }, [
    el("div", { class: "small" }, [
      `Changing ${rev.id} may affect ${impact.tasks.length} task(s), ${impact.approvals.length} approval(s) and ${impact.assets.length} asset(s).`
    ]),
    ...impact.tasks.slice(0, 4).map(w => el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/work-board/${w.projectId}`) }, [
      badge("Task", "info"), el("span", { class: "small" }, [w.title]),
    ])),
    ...impact.assets.slice(0, 4).map(a => el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/asset/${a.id}`) }, [
      badge("Asset", "accent"), el("span", { class: "small" }, [a.name]),
    ])),
    el("div", { class: "tiny muted" }, [
      "Citations: ", rev.id, impact.assets.slice(0, 3).map(a => ", " + a.id).join(""),
    ]),
  ]));
}

function crossLinks(doc) {
  const d = state.data;
  const drawings = d.drawings.filter(x => x.docId === doc.id);
  const assets = d.assets.filter(a => (a.docIds || []).includes(doc.id));
  return card("Cross-links", el("div", { class: "stack" }, [
    ...drawings.map(dr => el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/drawing/${dr.id}`) }, [
      badge("Drawing", "info"), el("span", { class: "small" }, [dr.name]),
    ])),
    ...assets.map(a => el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/asset/${a.id}`) }, [
      badge("Asset", "info"), el("span", { class: "small" }, [a.name]),
    ])),
  ]));
}

function askCard(doc, rev) {
  return card("AI — Ask this document", el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Answers cite the active revision."]),
    el("button", { class: "btn sm", onClick: () => navigate(`/ai?doc=${doc.id}&rev=${rev.id}`) }, ["Open AI →"]),
  ]));
}

// ---------- actions ----------
async function addCommentPin(docId, revId, page, presetX, presetY) {
  if (!can("create")) { toast("No permission", "warn"); return; }
  const text = await prompt({ title: "Regional comment", placeholder: "Comment text" });
  if (!text) return;
  const x = presetX != null ? presetX : 0.25 + Math.random() * 0.5;
  const y = presetY != null ? presetY : 0.15 + Math.random() * 0.6;
  const existing = (state.data.comments || []).filter(c => c.docId === docId && c.revId === revId);
  const c = {
    id: "CMT-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    docId, revId, page, x, y, text,
    author: state.ui.role,
    replies: [],
    seq: existing.length + 1,
    ts: new Date().toISOString(),
  };
  update(s => { s.data.comments = s.data.comments || []; s.data.comments.push(c); });
  audit("comment.create", c.id, { docId, revId, page });
  toast("Comment pinned", "success");
  renderDocViewer({ id: docId });
}

function openComment(c) {
  const replyBox = textarea({ placeholder: "Reply..." });
  modal({
    title: `Regional comment · p${c.page} #${c.seq}`,
    body: el("div", { class: "stack" }, [
      el("div", { class: "small" }, [c.text]),
      el("div", { class: "tiny muted" }, [`By ${c.author} · ${new Date(c.ts).toLocaleString()}`]),
      el("div", { class: "strong tiny" }, ["Replies"]),
      ...(c.replies || []).map(r => el("div", { class: "activity-row" }, [
        el("span", { class: "tiny muted", style: { width: "100px" } }, [r.author]),
        el("span", { class: "small" }, [r.text]),
      ])),
      formRow("Reply", replyBox),
    ]),
    actions: [
      { label: "Close" },
      { label: "Reply", variant: "primary", onClick: () => {
        const text = replyBox.value.trim();
        if (!text) return;
        update(s => {
          const ref = s.data.comments.find(x => x.id === c.id);
          if (!ref) return;
          ref.replies = ref.replies || [];
          ref.replies.push({ author: s.ui.role, text, ts: new Date().toISOString() });
        });
        audit("comment.reply", c.id);
        renderDocViewer({ id: c.docId });
      }},
      { label: "Convert to issue", onClick: () => convertCommentToIssue(c) },
    ],
  });
}

async function convertCommentToIssue(c) {
  if (!can("create")) return;
  const doc = getById("documents", c.docId);
  const title = await prompt({ title: "Convert to issue", message: "Issue title:", defaultValue: c.text.slice(0, 60) });
  if (!title) return;
  const projectId = doc?.projectId || (state.data.projects || [])[0]?.id;
  const id = "WI-" + Math.floor(Math.random() * 900 + 100);
  update(s => {
    s.data.workItems.push({
      id, projectId, type: "Issue", title, assigneeId: "U-1",
      status: "Open", severity: "medium", due: null, blockers: [],
      description: `Originated from comment ${c.id} on ${c.docId} revision ${c.revId}, page ${c.page}.`,
      labels: [c.docId, c.id],
    });
  });
  audit("comment.convert.issue", c.id, { workItemId: id });
  toast(`${id} created from comment`, "success");
  navigate(`/work-board/${projectId}`);
}

async function attachPdf(doc, rev) {
  const url = await prompt({
    title: "Attach asset URL",
    message: "Supported: PDF, image, CSV, CAD (" + supportedExtensions().join(", ") + "). Must be CORS-enabled.",
    defaultValue: rev.pdfUrl || rev.assetUrl || "https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf",
    placeholder: "https://...",
  });
  if (!url) return;
  const cad = detectCad(url);
  const kind = cad ? cad.kind : detectKind(url);
  update(s => {
    const r = s.data.revisions.find(x => x.id === rev.id);
    if (!r) return;
    if (kind === "pdf") { r.pdfUrl = url; r.assetUrl = null; }
    else { r.assetUrl = url; r.pdfUrl = null; r.assetMime = guessMime(url); }
  });
  audit("revision.asset.attach", rev.id, { url, kind: kind || "unknown" });
  toast(`${kind ? kind.toUpperCase() : "Asset"} attached — re-rendering`, "success");
  renderDocViewer({ id: doc.id });
}

function detectKind(url, mime) {
  if (!url) return null;
  const u = String(url).toLowerCase();
  if (mime?.startsWith("image/") || /\.(png|jpe?g|svg|webp|gif)(\?|#|$)/i.test(u)) return "image";
  if (mime === "text/csv" || /\.csv(\?|#|$)/i.test(u)) return "csv";
  if (mime?.includes("pdf") || /\.pdf(\?|#|$)/i.test(u)) return "pdf";
  return null;
}

function guessMime(url) {
  const u = url.toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".svg")) return "image/svg+xml";
  if (u.endsWith(".csv")) return "text/csv";
  if (u.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function renderCsvTable(parsed) {
  const { headers = [], rows = [] } = parsed || {};
  if (!headers.length && !rows.length) return el("div", { class: "muted" }, ["Empty CSV."]);
  const body = rows.slice(0, 200);
  return el("div", { style: { overflow: "auto", maxHeight: "60vh" } }, [
    el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, headers.map(h => el("th", {}, [h])))]),
      el("tbody", {}, body.map(r => el("tr", {}, headers.map((_, i) => el("td", {}, [r[i] ?? ""]))))),
    ]),
    rows.length > 200 ? el("div", { class: "tiny muted p-2" }, [`Showing 200 of ${rows.length} rows.`]) : null,
  ]);
}

function draftTransmittal(doc, rev) {
  const subject = input({ value: `${doc.name} — ${rev.label} ${rev.status}` });
  const recipients = input({ value: "package-3-team@atlas.example" });
  const note = textarea({ value: `Please find attached ${doc.name} revision ${rev.label} (${rev.status}). Effective ${new Date(rev.createdAt || rev.created_at || Date.now()).toLocaleDateString()}.` });
  modal({
    title: "Draft transmittal",
    body: el("div", { class: "stack" }, [
      formRow("Subject", subject),
      formRow("Recipients (comma-separated)", recipients),
      formRow("Message", note),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Send", variant: "primary", onClick: () => {
        const t = {
          id: "TX-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
          docId: doc.id,
          revId: rev.id,
          subject: subject.value,
          recipients: recipients.value.split(",").map(s => s.trim()).filter(Boolean),
          message: note.value,
          ts: new Date().toISOString(),
          sender: state.ui.role,
        };
        update(s => { s.data.transmittals = s.data.transmittals || []; s.data.transmittals.push(t); });
        audit("transmittal.send", t.id, { docId: doc.id, revId: rev.id });
        toast(`Transmittal ${t.id} sent`, "success");
        renderDocViewer({ id: doc.id });
      }},
    ],
  });
}
