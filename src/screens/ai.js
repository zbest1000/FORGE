// AI Workspace v2 — spec §11.15 and §14.
//
// RAG: queries pass through the BM25 index in core/search.js, filtered by
// ACL, and produce citation-backed answers. Prompt/output/tool-call logs are
// recorded with the retention policy tag. An Impact Analyzer uses the
// revision engine to explain downstream effects of changes.

import { el, mount, card, badge, toast, textarea, select, input } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { query as searchQuery } from "../core/search.js";
import { impactOfRevision } from "../core/revisions.js";
import { helpHint, helpLinkChip } from "../core/help.js";

const MODEL_OPTIONS = [
  { value: "local:llama-like",    label: "local · llama-class (no egress)" },
  { value: "tenant:enterprise-a", label: "tenant · enterprise model" },
  { value: "open:qwen-like",      label: "open · qwen-class" },
];

export function renderAI() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const thread = state.ui.aiThread || [];
  const params = new URLSearchParams((state.route.split("?")[1] || ""));
  const scopeDoc = params.get("doc");
  const scopeDrawing = params.get("drawing");
  const scopeChannel = params.get("channel");
  const scopeRev = params.get("rev");
  const model = sessionStorage.getItem("ai.model") || MODEL_OPTIONS[0].value;

  const inputBox = el("textarea", {
    placeholder: "Ask a question. Answers are permission-filtered and cite sources. (Enter to send; Shift+Enter newline)",
    onKeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(inputBox.value); inputBox.value = ""; } },
  });

  const modelSel = select(MODEL_OPTIONS, { value: model, onChange: e => sessionStorage.setItem("ai.model", e.target.value) });

  mount(root, [
    el("div", { style: { marginBottom: "12px" } }, [
      el("h2", { style: { display: "inline-flex", alignItems: "center", margin: 0, fontSize: "18px" } }, [
        "AI workspace", helpHint("forge.ai"),
      ]),
      el("div", { class: "tiny muted" }, ["Permission-filtered, citation-backed answers grounded in workspace data."]),
      el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
        helpLinkChip("forge.ai", "AI workspace"),
        helpLinkChip("forge.ai.citations", "Citations"),
      ]),
    ]),
    el("div", { class: "ai-layout" }, [
      el("div", { class: "ai-console" }, [
        el("div", { class: "ai-thread" },
          thread.length ? thread.map(renderBubble) : [welcome()]
        ),
        el("div", { class: "ai-composer" }, [
          inputBox,
          el("button", { class: "btn primary", onClick: () => { send(inputBox.value); inputBox.value = ""; } }, ["Send"]),
        ]),
      ]),
      el("div", { class: "stack" }, [
        card("Scope", scopeCard(scopeDoc, scopeRev, scopeDrawing, scopeChannel)),
        card("Model routing", el("div", { class: "stack" }, [modelSel, el("div", { class: "tiny muted" }, ["Tenant policy controls which models can be selected."])])),
        card("Suggested prompts", el("div", { class: "stack" }, [
          sbtn("Summarize my unread threads"),
          sbtn("What changed in Rev 2-C vs Rev 2-B?"),
          sbtn("Which incidents are active on Line A?"),
          sbtn("Draft a transmittal for IFC on DOC-2"),
          sbtn("Impact of REV-1-B"),
        ])),
        card("Policy", el("div", { class: "stack" }, [
          el("div", { class: "tiny muted" }, [
            "Retention: no training on tenant data · citations required · permission-filtered retrieval · tool calls audited",
          ]),
          el("button", { class: "btn sm", onClick: () => openLog() }, ["Prompt/output log →"]),
        ])),
        el("button", { class: "btn sm", onClick: () => { update(s => { s.ui.aiThread = []; }); } }, ["Clear thread"]),
      ]),
    ]),
  ]);

  function send(text) {
    text = (text || "").trim();
    if (!text) return;
    const user = { role: "user", text, ts: new Date().toISOString() };
    const { answer, citations, traceId } = rag(text, { scopeDoc, scopeRev, scopeDrawing, scopeChannel });
    const assist = { role: "assistant", text: answer, citations, ts: new Date().toISOString(), model, traceId };

    update(s => {
      s.ui.aiThread = [...(s.ui.aiThread || []), user, assist];
      s.data.aiLog = s.data.aiLog || [];
      s.data.aiLog.push({
        id: "AI-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        ts: assist.ts,
        prompt: text,
        output: answer,
        citations,
        model,
        scope: { scopeDoc, scopeRev, scopeDrawing, scopeChannel },
        actor: s.ui.role,
        traceId,
        retention: "no-training-by-default",
      });
    });
    audit("ai.call", "ai.workspace", { traceId, model, citations: citations.length });
  }
}

function scopeCard(scopeDoc, scopeRev, scopeDrawing, scopeChannel) {
  const any = scopeDoc || scopeRev || scopeDrawing || scopeChannel;
  return el("div", { class: "stack" }, [
    scopeDoc ? el("div", {}, ["Document: ", el("span", { class: "mono" }, [scopeDoc])]) : null,
    scopeRev ? el("div", {}, ["Revision: ", el("span", { class: "mono" }, [scopeRev])]) : null,
    scopeDrawing ? el("div", {}, ["Drawing: ", el("span", { class: "mono" }, [scopeDrawing])]) : null,
    scopeChannel ? el("div", {}, ["Channel: ", el("span", { class: "mono" }, [scopeChannel])]) : null,
    !any ? el("div", { class: "muted tiny" }, ["Workspace-wide (permission-filtered)"]) : null,
  ]);
}

function welcome() {
  return el("div", { class: "ai-bubble assistant" }, [
    el("div", { class: "small" }, [
      "I'm the FORGE assistant. Questions are answered with citations from objects you can access. Try one of the suggested prompts on the right, or ask about a specific revision, incident, or asset.",
    ]),
  ]);
}

function renderBubble(m) {
  const node = el("div", { class: `ai-bubble ${m.role}` }, [
    el("div", { class: "small" }, [m.text]),
  ]);
  if (m.citations?.length) {
    node.append(el("div", { class: "citations" }, m.citations.map(c => badge(c, "accent"))));
  }
  if (m.traceId) node.append(el("div", { class: "tiny muted", style: { marginTop: "4px" } }, [`trace=${m.traceId} · model=${m.model || "—"}`]));
  return node;
}

function sbtn(prompt) {
  return el("button", { class: "btn sm", onClick: () => {
    const t = /** @type {HTMLTextAreaElement | null} */ (document.querySelector(".ai-composer textarea"));
    if (!t) return;
    t.value = prompt; t.focus();
    // Auto-send.
    const evt = new KeyboardEvent("keydown", { key: "Enter" });
    t.dispatchEvent(evt);
  }}, [prompt]);
}

function openLog() {
  const logs = (state.data.aiLog || []).slice(-40).reverse();
  const body = el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Most recent AI calls (bounded at 40)."]),
    ...(logs.length ? logs.map(l => el("div", { class: "activity-row" }, [
      el("span", { class: "ts mono" }, [new Date(l.ts).toLocaleString()]),
      el("span", { class: "small", style: { flex: 1 } }, [
        (l.prompt || "").slice(0, 80),
        " → ",
        (l.output || "").slice(0, 80),
      ]),
      el("span", { class: "tiny muted" }, [l.model || ""]),
    ])) : [el("div", { class: "muted tiny" }, ["(no calls yet)"])]),
  ]);
  import("../core/ui.js").then(u => u.modal({ title: "AI log", body, actions: [{ label: "Close" }] }));
}

// ---------- retrieval + answer ----------
function rag(q, scope) {
  const traceId = "trace-ai-" + Math.random().toString(36).slice(2, 10);
  const d = state.data;

  // Impact special-case: "Impact of REV-*"
  const impactMatch = q.match(/impact of (REV-[A-Z0-9-]+)/i);
  if (impactMatch) {
    const id = impactMatch[1];
    const imp = impactOfRevision(id);
    if (!imp.rev) return { answer: `${id} not found.`, citations: [], traceId };
    const citations = [id, ...imp.assets.map(a => a.id), ...imp.tasks.map(t => t.id)].slice(0, 6);
    return {
      answer: `Changing ${id} may affect ${imp.tasks.length} task(s), ${imp.approvals.length} approval(s) and ${imp.assets.length} asset(s).` +
        (imp.tasks.length ? ` Tasks: ${imp.tasks.map(t => t.id).join(", ")}.` : "") +
        (imp.assets.length ? ` Assets: ${imp.assets.map(a => a.name).join(", ")}.` : ""),
      citations,
      traceId,
    };
  }

  // Unread / summary
  if (/unread|summariz/i.test(q)) {
    const channels = (d.channels || []).filter(c => c.unread > 0);
    const citations = channels.map(c => "CH:" + c.id).slice(0, 6);
    return { answer: `${channels.length} channels with unread activity: ${channels.map(c => "#" + c.name).join(", ")}. Priority: #line-a-controls (review pending), #ops-floor-a (alarms).`, citations, traceId };
  }

  // Revision delta
  const relMatch = q.match(/(REV-[A-Z0-9-]+)\s+vs\s+(REV-[A-Z0-9-]+)/i);
  if (relMatch) {
    const [_, a, b] = relMatch;
    return { answer: `${a} vs ${b}: see metadata diff on /compare/${a}/${b}. In the seed, REV-2-C introduced an emergency vent interlock and revised valve sizing over REV-2-B.`, citations: [a, b], traceId };
  }

  // Active incidents
  if (/active.*incident|incident.*active/i.test(q)) {
    const inc = (d.incidents || []).filter(i => i.status === "active");
    return { answer: inc.length ? `Active incidents: ${inc.map(i => i.id + " (" + i.title + ")").join("; ")}.` : "No active incidents.", citations: inc.map(i => i.id), traceId };
  }

  // Default: run BM25
  const res = searchQuery(q, { limit: 6 });
  const hits = res.hits;
  if (!hits.length) return { answer: `Searched ${(d.documents || []).length} docs and ${(d.messages || []).length} messages — no strong matches for "${q}". Try narrowing with scope chips.`, citations: [], traceId };

  const citations = hits.map(h => h.id);
  const top = hits.slice(0, 3).map(h => `${h.kind} ${h.id} (${h.title})`).join("; ");
  const answer = `Top matches for "${q}": ${top}. All results filtered by role ACL; see citations to jump to source.`;
  return { answer, citations, traceId };
}
