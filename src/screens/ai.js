import { el, mount, card, badge } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";

export function renderAI() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const thread = state.ui.aiThread || [];
  const params = new URLSearchParams((state.route.split("?")[1] || ""));
  const scopeDoc = params.get("doc");
  const scopeDrawing = params.get("drawing");
  const scopeRev = params.get("rev");

  const input = el("textarea", {
    placeholder: "Ask a question — answers cite sources. (Enter to send)",
    onKeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); input.value = ""; } },
  });

  mount(root, [
    el("div", { class: "ai-layout" }, [
      el("div", { class: "ai-console" }, [
        el("div", { class: "ai-thread" },
          thread.length
            ? thread.map(renderBubble)
            : [welcomeBubble()]
        ),
        el("div", { class: "ai-composer" }, [
          input,
          el("button", { class: "btn primary", disabled: !can("view"), onClick: () => { send(input.value); input.value = ""; } }, ["Send"]),
        ]),
      ]),
      el("div", { class: "stack" }, [
        card("Scope", el("div", { class: "stack" }, [
          scopeDoc ? el("div", {}, ["Document: ", el("span", { class: "mono" }, [scopeDoc])]) : null,
          scopeRev ? el("div", {}, ["Revision: ", el("span", { class: "mono" }, [scopeRev])]) : null,
          scopeDrawing ? el("div", {}, ["Drawing: ", el("span", { class: "mono" }, [scopeDrawing])]) : null,
          !scopeDoc && !scopeRev && !scopeDrawing ? el("div", { class: "muted tiny" }, ["Workspace-wide (permission-filtered)"]) : null,
        ])),
        card("Suggested prompts", el("div", { class: "stack" }, [
          suggested("Summarize my unread threads", d),
          suggested("What changed in Rev 2-C vs Rev 2-B?", d),
          suggested("Which incidents are active on Line A?", d),
          suggested("Draft a transmittal for IFC on DOC-2", d),
        ])),
        card("Policy", el("div", { class: "stack" }, [
          el("div", { class: "tiny muted" }, ["Retention: no training on tenant data · citations required · permission-filtered retrieval"]),
        ])),
        el("button", { class: "btn sm", onClick: () => { update(s => { s.ui.aiThread = []; }); } }, ["Clear thread"]),
      ]),
    ]),
  ]);

  function send(text) {
    text = (text || "").trim();
    if (!text) return;
    const userMsg = { role: "user", text, ts: new Date().toISOString() };
    const { answer, citations } = mockAnswer(text, d, { scopeDoc, scopeRev, scopeDrawing });
    const assistMsg = { role: "assistant", text: answer, citations, ts: new Date().toISOString() };
    update(s => { s.ui.aiThread = [...(s.ui.aiThread || []), userMsg, assistMsg]; });
  }
}

function welcomeBubble() {
  return el("div", { class: "ai-bubble assistant" }, [
    el("div", { class: "small" }, [
      "I'm the FORGE assistant. Ask about revisions, assets, incidents, or draft reports. Answers are permission-filtered and citation-backed.",
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
  return node;
}

function suggested(prompt, d) {
  return el("button", { class: "btn sm", onClick: () => {
    update(s => {
      const userMsg = { role: "user", text: prompt, ts: new Date().toISOString() };
      const { answer, citations } = mockAnswer(prompt, d, {});
      s.ui.aiThread = [...(s.ui.aiThread || []), userMsg, { role: "assistant", text: answer, citations, ts: new Date().toISOString() }];
    });
  }}, [prompt]);
}

function mockAnswer(query, d, scope) {
  const q = query.toLowerCase();
  const citations = [];
  let answer = "";

  if (q.includes("unread") || q.includes("summarize")) {
    const unread = (d.channels || []).filter(c => c.unread > 0);
    citations.push(...unread.map(c => `CH:${c.id}`));
    answer = `${unread.length} channels have unread activity. Top item: new reviews pending on #line-a-controls; incident channel #incident-b-24h has historical context. Recommend opening #ops-floor-a first.`;
  } else if (q.includes("rev") && q.includes("vs")) {
    const rev = (d.revisions || []).find(r => r.label === "C" && r.docId === "DOC-2");
    if (rev) citations.push(rev.id, "REV-2-B");
    answer = `REV-2-C introduced an emergency vent interlock and revised valve sizing on the Utility Header. REV-2-B had the original valve set. Impact: affects WI-104 (Approved), PSV-14 tag on drawing DRW-1.`;
  } else if (q.includes("incident") || q.includes("active")) {
    const inc = (d.incidents || []).filter(i => i.status === "active");
    citations.push(...inc.map(i => i.id));
    answer = inc.length ? `${inc.length} active incident(s): ${inc.map(i => `${i.id} (${i.title})`).join("; ")}. Asset AS-1 is in alarm.` : "No active incidents.";
  } else if (q.includes("transmittal") || q.includes("ifc") || q.includes("draft")) {
    citations.push("DOC-2", "REV-2-C");
    answer = `Transmittal draft: "Issued For Construction (IFC) — Package 3 Utilities (DOC-2) Revision C. Changes include emergency vent interlock and updated valve sizing. Recipients: Package 3 team. Effective date: today."`;
  } else {
    citations.push("search:keyword");
    answer = `Searched ${(d.documents || []).length} docs, ${(d.assets || []).length} assets, and ${(d.messages || []).length} messages for "${query}". Narrow the query with scope chips to get better citations.`;
  }

  if (scope.scopeDoc) citations.push(scope.scopeDoc);
  if (scope.scopeRev) citations.push(scope.scopeRev);
  if (scope.scopeDrawing) citations.push(scope.scopeDrawing);

  return { answer, citations };
}
