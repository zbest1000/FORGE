// i3X API Workbench — pick an endpoint, fill params, see request + raw response
// envelopes. Live-streams subscription updates in a console.

import { el, mount, card, badge, toast, input, textarea, select, formRow } from "../core/ui.js";
import { state } from "../core/store.js";
import { i3x, getServer } from "../core/i3x/client.js";

const ENDPOINTS = [
  { id: "info",             method: "GET",  path: "/info",             tag: "Info" },
  { id: "namespaces",       method: "GET",  path: "/namespaces",       tag: "Explore" },
  { id: "objectTypes",      method: "GET",  path: "/objecttypes",      tag: "Explore", params: [{ name: "namespaceUri", kind: "query" }] },
  { id: "relationshipTypes",method: "GET",  path: "/relationshiptypes",tag: "Explore", params: [{ name: "namespaceUri", kind: "query" }] },
  { id: "objects",          method: "GET",  path: "/objects",          tag: "Explore", params: [{ name: "typeElementId", kind: "query" }, { name: "root", kind: "query" }, { name: "includeMetadata", kind: "query", type: "bool" }] },
  { id: "listObjects",      method: "POST", path: "/objects/list",     tag: "Explore", body: { elementIds: [] } },
  { id: "relatedObjects",   method: "POST", path: "/objects/related",  tag: "Explore", body: { elementIds: [], relationshipType: null } },
  { id: "value",            method: "POST", path: "/objects/value",    tag: "Query",   body: { elementIds: [], maxDepth: 1 } },
  { id: "history",          method: "POST", path: "/objects/history",  tag: "Query",   body: { elementIds: [], maxDepth: 1 } },
  { id: "putValue",         method: "PUT",  path: "/objects/{id}/value", tag: "Update", params: [{ name: "elementId", kind: "path" }], body: { value: 0, quality: "Good" } },
  { id: "createSubscription", method: "POST", path: "/subscriptions",            tag: "Subscribe", body: { clientId: "forge-ui", displayName: "UI session" } },
  { id: "registerItems",      method: "POST", path: "/subscriptions/register",   tag: "Subscribe", body: { subscriptionId: "", elementIds: [] } },
  { id: "sync",               method: "POST", path: "/subscriptions/sync",       tag: "Subscribe", body: { subscriptionId: "", lastSequenceNumber: null } },
  { id: "listSubscriptions",  method: "POST", path: "/subscriptions/list",       tag: "Subscribe", body: { subscriptionIds: [] } },
  { id: "deleteSubscriptions",method: "POST", path: "/subscriptions/delete",     tag: "Subscribe", body: { subscriptionIds: [] } },
];

const _session = {
  lastRequest: null,
  lastResponse: null,
  subscriptionId: null,
  streamHandle: null,
  streamLog: [],
};

export function renderI3X() {
  const root = document.getElementById("screenContainer");
  const params = new URLSearchParams((state.route.split("?")[1] || ""));
  const epId = params.get("ep") || "info";
  const endpoint = ENDPOINTS.find(e => e.id === epId) || ENDPOINTS[0];

  const pre = sessionStorage.getItem("i3x.presubscribe");
  if (pre) sessionStorage.removeItem("i3x.presubscribe");

  const defaultBody = endpoint.body ? JSON.parse(JSON.stringify(endpoint.body)) : null;
  // Helpful defaults from context. The previous version assumed every
  // installation had an `isa95:Equipment`-typed object available, and
  // bailed silently when it didn't — leaving the workbench in a
  // "click Run, get empty response" state that read as broken. Now
  // we fall back through a couple of likely types and finally pick
  // any available object so the Run button always returns something.
  const seedElementIds = pickSeedElementIds(3);
  if (seedElementIds.length) {
    if (endpoint.id === "listObjects" || endpoint.id === "value" || endpoint.id === "history") {
      defaultBody.elementIds = seedElementIds;
    }
    if (endpoint.id === "relatedObjects") {
      defaultBody.elementIds = [seedElementIds[0]];
    }
  }
  if (pre && (endpoint.id === "value" || endpoint.id === "history" || endpoint.id === "listObjects" || endpoint.id === "registerItems")) {
    defaultBody.elementIds = [pre];
  }
  if ((endpoint.id === "registerItems" || endpoint.id === "sync") && _session.subscriptionId) {
    defaultBody.subscriptionId = _session.subscriptionId;
  }

  const paramInputs = {};
  const paramEls = (endpoint.params || []).map(p => {
    const inp = input({ placeholder: p.name + (p.kind === "query" ? " (query)" : p.kind === "path" ? " (path)" : "") });
    paramInputs[p.name] = { inp, kind: p.kind, type: p.type };
    return formRow(p.name, inp);
  });

  let bodyArea = null;
  if (defaultBody) {
    bodyArea = textarea({ value: JSON.stringify(defaultBody, null, 2) });
  }

  const requestBox = el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px", overflow: "auto", maxHeight: "300px" } });
  const responseBox = el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px", overflow: "auto", maxHeight: "400px" } });

  function syncPreview() {
    const req = buildRequest(endpoint, paramInputs, bodyArea);
    requestBox.textContent = JSON.stringify(req, null, 2);
  }
  syncPreview();
  (bodyArea && bodyArea.addEventListener("input", syncPreview));
  Object.values(paramInputs).forEach(p => p.inp.addEventListener("input", syncPreview));

  const streamPanel = renderStreamPanel();

  mount(root, [
    headerRow(),
    rapidocCard(),
    el("div", { class: "two-col" }, [
      card("Endpoints", endpointList(epId)),
      endpointCard(endpoint, paramEls, bodyArea, requestBox, responseBox, () => {
        const req = buildRequest(endpoint, paramInputs, bodyArea);
        _session.lastRequest = req;
        const res = invoke(endpoint, req);
        _session.lastResponse = res;
        responseBox.textContent = JSON.stringify(res, null, 2);
        // Side-effects for subscription wiring.
        if (endpoint.id === "createSubscription" && res?.success) {
          _session.subscriptionId = res.data.subscriptionId;
          toast(`Subscription created: ${_session.subscriptionId}`, "success");
        }
      }),
    ]),
    streamPanel,
    renderSpecCard(),
  ]);
}

// Pick element ids the workbench can use as default request body so
// users hitting "Run" on a fresh install always see real data flow,
// not an empty response from an empty `elementIds: []` body. Falls
// back through a few common ISA-95 types and finally picks anything
// available. Defensive against the server not being initialised yet.
function pickSeedElementIds(n = 3) {
  let server;
  try { server = getServer(); } catch { return []; }
  const tryTypes = ["isa95:Equipment", "isa95:Production", "isa95:WorkUnit", "isa95:Site", null];
  for (const t of tryTypes) {
    try {
      const res = server.getObjects(t ? { typeElementId: t } : {});
      const ids = (res?.data || []).map(o => o.elementId).filter(Boolean);
      if (ids.length) return ids.slice(0, n);
    } catch { /* try next */ }
  }
  return [];
}

function rapidocCard() {
  // RapiDoc (MIT) renders the live CESMII i3X OpenAPI spec. We load the
  // custom element eagerly from the <script type="module"> in index.html.
  const rd = document.createElement("rapi-doc");
  rd.setAttribute("spec-url", "https://api.i3x.dev/v1/openapi.json");
  rd.setAttribute("render-style", "read");
  rd.setAttribute("theme", document.body.classList.contains("theme-light") ? "light" : "dark");
  rd.setAttribute("show-header", "false");
  rd.setAttribute("allow-try", "false");
  rd.style.height = "360px";
  rd.style.width = "100%";
  rd.style.display = "block";
  rd.style.borderRadius = "8px";
  rd.style.border = "1px solid var(--border)";
  return card("i3X OpenAPI reference (rapidoc)", rd, {
    subtitle: "Live spec from https://api.i3x.dev/v1/openapi.json · rendered by RapiDoc (MIT)",
  });
}

function headerRow() {
  const info = getServer().getInfo().data;
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", {}, [
      el("div", { class: "strong" }, ["i3X API Workbench"]),
      el("div", { class: "tiny muted" }, [
        `Implementation: ${info.implementation} · Spec: i3X ${info.version}`,
      ]),
    ]),
    el("div", { class: "row" }, [
      badge("api base: /v1", "accent"),
      badge(`subs: ${info.subscriptions}`, "info"),
      badge(`objects: ${info.objects}`, ""),
    ]),
  ]);
}

function endpointList(activeId) {
  const groups = {};
  for (const ep of ENDPOINTS) (groups[ep.tag] = groups[ep.tag] || []).push(ep);
  const wrap = el("div", { class: "stack" });
  for (const [tag, list] of Object.entries(groups)) {
    wrap.append(el("div", { class: "tree-group-title" }, [tag]));
    // UX-E: endpoint rows are the click target with no inner
    // interactive children, so they render as real <button>s.
    // Keyboard activation is intrinsic; the
    // `installRowKeyboardHandlers()` observer no longer needs to
    // retro-fit role + tabindex.
    list.forEach(ep => wrap.append(el("button", {
      type: "button",
      class: `tree-item ${ep.id === activeId ? "active" : ""}`,
      onClick: () => { window.location.hash = `#/i3x?ep=${ep.id}`; },
    }, [
      el("span", { class: "tree-dot" }),
      el("span", { class: "mono tiny", style: { minWidth: "40px" } }, [ep.method]),
      el("span", { class: "small" }, [ep.path]),
    ])));
  }
  return wrap;
}

function endpointCard(endpoint, paramEls, bodyArea, requestBox, responseBox, onRun) {
  return card(`${endpoint.method} ${endpoint.path}`, el("div", { class: "stack" }, [
    ...paramEls,
    bodyArea ? formRow("Request body (JSON)", bodyArea) : null,
    el("div", { class: "row" }, [
      el("button", { class: "btn primary", onClick: onRun }, ["Send →"]),
      el("button", { class: "btn sm", onClick: () => { navigator.clipboard?.writeText(requestBox.textContent); toast("Request copied", "success"); }}, ["Copy request"]),
      el("button", { class: "btn sm", onClick: () => { navigator.clipboard?.writeText(responseBox.textContent); toast("Response copied", "success"); }}, ["Copy response"]),
    ]),
    el("div", { class: "tiny muted" }, ["Resolved request"]),
    requestBox,
    el("div", { class: "tiny muted" }, ["Response envelope"]),
    responseBox,
  ]));
}

function renderStreamPanel() {
  const logBox = el("pre", { class: "mono tiny", style: { background: "var(--panel)", padding: "12px", borderRadius: "6px", overflow: "auto", maxHeight: "240px", minHeight: "120px" } }, [_session.streamLog.join("\n")]);

  const subIdInput = input({ placeholder: "subscriptionId", value: _session.subscriptionId || "" });

  function appendLog(line) {
    _session.streamLog.push(line);
    if (_session.streamLog.length > 200) _session.streamLog.splice(0, _session.streamLog.length - 200);
    logBox.textContent = _session.streamLog.join("\n");
    logBox.scrollTop = logBox.scrollHeight;
  }

  return card("Subscription stream (SSE simulated)", el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      subIdInput,
      el("button", {
        class: "btn sm primary",
        onClick: () => {
          const sid = subIdInput.value.trim();
          if (!sid) { toast("Create or paste a subscriptionId first", "warn"); return; }
          if (_session.streamHandle) { _session.streamHandle.close(); _session.streamHandle = null; }
          const res = i3x.stream(sid, (u) => appendLog(`seq=${u.sequenceNumber}  ${u.elementId}  value=${u.value}  q=${u.quality}  ${u.timestamp}`));
          if (res.success) {
            _session.streamHandle = res.data;
            appendLog(`[stream opened] subscription=${sid} items=${res.data.items.length}`);
          } else {
            toast(res.error?.message || "stream failed", "danger");
          }
        },
      }, ["Open stream"]),
      el("button", {
        class: "btn sm",
        onClick: () => {
          if (_session.streamHandle) { _session.streamHandle.close(); _session.streamHandle = null; appendLog("[stream closed]"); }
        },
      }, ["Close"]),
      el("button", {
        class: "btn sm",
        onClick: () => {
          const sid = subIdInput.value.trim();
          if (!sid) return;
          const res = i3x.syncSubscription({ subscriptionId: sid, lastSequenceNumber: null });
          if (res.success) appendLog(`[sync] got ${res.data.length} queued updates`);
        },
      }, ["Sync"]),
    ]),
    logBox,
    el("div", { class: "tiny muted" }, ["Server ticks ~1.5s simulating MQTT/OPC UA ingress."]),
  ]));
}

function renderSpecCard() {
  return card("Spec conformance", el("div", { class: "stack" }, [
    el("div", { class: "small" }, [
      "This engine implements the CESMII i3X 1.0-Beta primitive set end-to-end in-process (no network). ",
      "Endpoints return the exact success/bulk envelopes and VQT shapes of the official OpenAPI.",
    ]),
    el("div", { class: "row wrap" }, [
      badge("Explore", "info"), badge("Query", "info"), badge("Update", "info"),
      badge("Subscribe + Stream", "info"), badge("Bulk responses", "accent"),
      badge("Composition (instance-only)", ""), badge("ISA-95 types", "purple"),
    ]),
    el("div", { class: "tiny muted" }, ["Swap this client for an HTTP fetch() against any compliant i3X server — the UI stays identical."]),
  ]));
}

function buildRequest(endpoint, paramInputs, bodyArea) {
  const query = {};
  const path = {};
  for (const [k, { inp, kind, type }] of Object.entries(paramInputs)) {
    if (!inp.value) continue;
    const val = type === "bool" ? /^(1|true|yes)$/i.test(inp.value) : inp.value;
    if (kind === "query") query[k] = val;
    else if (kind === "path") path[k] = val;
  }

  let body = null;
  if (bodyArea) {
    try {
      body = JSON.parse(bodyArea.value || "null");
    } catch (e) {
      body = { _parseError: e.message };
    }
  }

  let resolvedPath = endpoint.path;
  for (const [k, v] of Object.entries(path)) resolvedPath = resolvedPath.replace(`{${k}}`, v);
  if (resolvedPath.includes("{id}")) resolvedPath = resolvedPath.replace("{id}", path.elementId || "");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) qs.set(k, v);
  const full = qs.toString() ? `${resolvedPath}?${qs}` : resolvedPath;

  return { method: endpoint.method, url: full, query, path, body };
}

function invoke(endpoint, req) {
  try {
    switch (endpoint.id) {
      case "info": return i3x.info();
      case "namespaces": return i3x.namespaces();
      case "objectTypes": return i3x.objectTypes(req.query.namespaceUri);
      case "relationshipTypes": return i3x.relationshipTypes(req.query.namespaceUri);
      case "objects": return i3x.objects({
        typeElementId: req.query.typeElementId || null,
        includeMetadata: !!req.query.includeMetadata,
        root: req.query.root ? /^(1|true|yes)$/i.test(req.query.root) : null,
      });
      case "listObjects": return i3x.listObjects(req.body);
      case "relatedObjects": return i3x.relatedObjects(req.body);
      case "value": return i3x.value(req.body);
      case "history": return i3x.history(req.body);
      case "putValue": return i3x.putValue(req.path.elementId, req.body);
      case "createSubscription": return i3x.createSubscription(req.body);
      case "registerItems": return i3x.registerItems(req.body);
      case "sync": return i3x.syncSubscription(req.body);
      case "listSubscriptions": return i3x.listSubscriptions(req.body);
      case "deleteSubscriptions": return i3x.deleteSubscriptions(req.body);
    }
    return { success: false, error: { code: 400, message: "Unknown endpoint" } };
  } catch (e) {
    return { success: false, error: { code: 500, message: e.message } };
  }
}
