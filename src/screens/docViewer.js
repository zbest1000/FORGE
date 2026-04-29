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

import { el, mount, card, badge, toast, chip, modal, formRow, input, select, textarea, prompt } from "../core/ui.js";
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

export function renderDocsIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    docsToolbar(),
    card("Documents", el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, ["Name","Discipline","Sensitivity","Current Rev","Revisions",""].map(h => el("th", {}, [h])))]),
      el("tbody", {}, (d.documents || []).map(doc => {
        const rev = getById("revisions", doc.currentRevisionId);
        return el("tr", { class: "row-clickable", onClick: () => navigate(`/doc/${doc.id}`) }, [
          el("td", {}, [doc.name, el("div", { class: "tiny muted" }, [doc.id])]),
          el("td", {}, [badge(doc.discipline, "info")]),
          el("td", {}, [doc.sensitivity]),
          el("td", {}, [rev ? badge(`${rev.label} · ${rev.status}`, `rev-${rev.status.toLowerCase()}`) : "—"]),
          el("td", { class: "tiny muted" }, [String(doc.revisionIds?.length || 0)]),
          el("td", {}, [el("button", { class: "btn sm", onClick: (e) => { e.stopPropagation(); navigate(`/doc/${doc.id}`); } }, ["Open"])]),
        ]);
      })),
    ])),
    docsDropZone(),
  ]);
}

// Toolbar with native OS file-picker affordances. The hidden <input
// type="file"> element is the standard browser primitive that drives
// the OS file dialog (Finder on macOS, Files on Windows, Nautilus etc.
// on Linux). Clicking the visible button triggers the input.
function docsToolbar() {
  const fileInput = el("input", {
    type: "file",
    multiple: true,
    accept: ".pdf,.doc,.docx,.dwg,.dxf,.ifc,.step,.stp,.iges,.igs,.png,.jpg,.jpeg,.svg,.txt,.csv,.md",
    style: { display: "none" },
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) ingestFiles(Array.from(fileInput.files));
    fileInput.value = ""; // reset so re-selecting the same file fires
  });
  return el("div", { class: "row spread", style: { marginBottom: "12px", gap: "8px" } }, [
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
      created_at: ts,
      updated_at: ts,
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
      created_at: ts,
      updated_at: ts,
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
      el("div", { class: "revision-safety-title" }, [doc.name]),
      el("div", { class: "revision-safety-state" }, [stateLabel]),
      el("div", { class: "revision-safety-guidance" }, [guidance]),
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
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", { class: "row wrap" }, [
      badge(doc.id, "info"),
      badge(doc.discipline || "—", "info"),
      badge(`Rev ${rev.label}`, `rev-${rev.status.toLowerCase()}`),
      badge(rev.status, revVariant(rev.status)),
      badge(doc.sensitivity || "—", "warn"),
      el("span", { class: "tiny muted" }, [`Effective ${new Date(rev.createdAt).toLocaleDateString()}`]),
    ]),
    el("div", { class: "row" }, [
      el("button", { class: "btn sm", onClick: () => followToggle(doc.id) }, [isFollowing(doc.id) ? "Unfollow" : "Follow"]),
    ]),
  ]);
}

function followToggle(docId) {
  if (isFollowing(docId)) unfollow(docId); else follow(docId);
  renderDocViewer({ id: docId });
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

function canvasArea(doc, rev, activePage) {
  return el("div", { class: "viewer-canvas" }, [
    el("div", { class: "viewer-toolbar" }, [
      el("button", { class: "btn sm", disabled: activePage <= 1, onClick: () => goPage(doc.id, activePage - 1) }, ["← Prev"]),
      el("span", { class: "tiny muted" }, [`Page ${activePage} of ${PAGES}`]),
      el("button", { class: "btn sm", disabled: activePage >= PAGES, onClick: () => goPage(doc.id, activePage + 1) }, ["Next →"]),
      el("span", { style: { flex: 1 } }),
      el("button", { class: "btn sm primary", disabled: !can("create"), onClick: () => addCommentPin(doc.id, rev.id, activePage) }, ["+ Regional comment"]),
      el("button", { class: "btn sm", onClick: () => draftTransmittal(doc, rev) }, ["Draft transmittal"]),
      el("button", { class: "btn sm", onClick: () => attachPdf(doc, rev) }, [rev.pdfUrl ? "Change PDF" : "Attach PDF"]),
    ]),
    el("div", { class: "viewer-page", id: `paper-${doc.id}` }, [
      paperPage(doc, rev, activePage),
    ]),
    pageStrip(doc, activePage),
  ]);
}

function paperPage(doc, rev, page) {
  const comments = (state.data.comments || []).filter(c => c.docId === doc.id && c.revId === rev.id && c.page === page);
  const container = el("div", { class: "paper" }, [
    el("h2", {}, [`${doc.name} — page ${page}`]),
    el("div", { class: "paper-meta" }, [`${doc.id}  ·  Rev ${rev.label} ${rev.status}  ·  ${new Date(rev.createdAt).toLocaleDateString()}`]),
    paperContent(doc, rev, page),
    ...comments.map(c => commentPin(c)),
  ]);

  // If the revision has an attached URL, pick the renderer by content kind.
  // CAD formats (DWG/DXF/STEP/IGES/STL/OBJ/glTF/3DM/3DS/3MF/FBX/DAE/PLY/IFC/...)
  // are routed to the unified CAD viewer; PDF/image/CSV stay on their
  // existing renderers.
  const url = rev.pdfUrl || rev.assetUrl || null;
  const cadKind = detectCad(url, rev.assetMime);
  if (url && cadKind && cadKind.viewer !== "image" && cadKind.viewer !== "pdf" && cadKind.viewer !== "csv") {
    const host = document.createElement("div");
    host.style.minHeight = "70vh";
    container.replaceChildren(host);
    renderCad(host, { url, name: url, mime: rev.assetMime }).catch(() => {});
    for (const c of comments) container.append(commentPin(c));
    return container;
  }
  const kind = detectKind(url, rev.assetMime);
  if (url && kind) {
    const host = document.createElement("div");
    host.className = "asset-host";
    host.style.minHeight = "420px";
    host.textContent = "Loading…";
    (async () => {
      try {
        if (kind === "pdf") {
          const pdf = await openPdf(url);
          if (!pdf) { host.textContent = "PDF.js unavailable — showing placeholder."; return; }
          await renderPage(pdf, Math.min(page, pdf.numPages), host);
        } else if (kind === "image") {
          host.replaceChildren(el("img", { src: url, alt: doc.name + " — page " + page, style: { maxWidth: "100%", border: "1px solid var(--border)", borderRadius: "6px", background: "#fff" } }));
        } else if (kind === "csv") {
          const text = await fetch(url).then(r => r.text()).catch(() => null);
          if (!text) { host.textContent = "Failed to load CSV."; return; }
          const parsed = await parseCSV(text);
          host.replaceChildren(renderCsvTable(parsed));
        }
      } catch (e) {
        host.textContent = "Failed to render: " + e.message;
      }
    })();
    container.replaceChildren(host);
    for (const c of comments) container.append(commentPin(c));
  }

  container.addEventListener("click", (e) => {
    if (!can("create")) return;
    if (!e.altKey) return; // hold Alt to drop a pin; otherwise clicks do nothing
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
  const meta = [
    ["Discipline", doc.discipline],
    ["Project", doc.projectId],
    ["Package", doc.package || "—"],
    ["Area", doc.area || "—"],
    ["Line", doc.line || "—"],
    ["System", doc.system || "—"],
    ["Vendor", doc.vendor || "—"],
    ["Sensitivity", doc.sensitivity],
    ["Revision", `${rev.label} · ${rev.status}`],
    ["Approver", rev.approverId || "—"],
    ["Effective", new Date(rev.createdAt).toLocaleDateString()],
  ];
  return card("Metadata", el("div", { class: "stack" }, meta.map(([k, v]) =>
    el("div", { class: "row" }, [
      el("span", { class: "tiny muted", style: { width: "90px" } }, [k]),
      el("span", { class: "small" }, [String(v || "—")]),
    ])
  )));
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
    rows.length > 200 ? el("div", { class: "tiny muted", style: { padding: "8px" } }, [`Showing 200 of ${rows.length} rows.`]) : null,
  ]);
}

function draftTransmittal(doc, rev) {
  const subject = input({ value: `${doc.name} — ${rev.label} ${rev.status}` });
  const recipients = input({ value: "package-3-team@atlas.example" });
  const note = textarea({ value: `Please find attached ${doc.name} revision ${rev.label} (${rev.status}). Effective ${new Date(rev.createdAt).toLocaleDateString()}.` });
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
