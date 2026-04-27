// Channel v2 — spec §11.3 and §6.1.
//
// Features:
//   * Message stream with avatar, thread type, inline object chips
//   * Composer with Enter-to-send, checklist block syntax
//   * Edit / delete own messages with audit trail (spec §11.3 audit)
//   * Convert message to work item / escalate to incident
//   * Pinned objects strip, thread drawer
//   * Follow/unfollow channel
//   * Decision markers

import { el, mount, card, badge, toast, chip, modal, formRow, textarea, select, input, prompt, dangerAction } from "../core/ui.js";
import { state, update, getById } from "../core/store.js";
import { audit } from "../core/audit.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { follow, unfollow, isFollowing, fanout } from "../core/subscriptions.js";
import { renderMarkdown } from "../core/md.js";
import { notifyMentions, highlightMentions, resolveMention } from "../core/mentions.js";

export function renderChannel({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const ch = getById("channels", id);
  if (!ch) return mount(root, el("div", { class: "muted" }, ["Channel not found."]));

  const ts = getById("teamSpaces", ch.teamSpaceId);
  const messages = (d.messages || [])
    .filter(m => m.channelId === id)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const composer = el("textarea", {
    placeholder: `Message #${ch.name}. Lines starting with "[ ]" become a checklist.`,
    onKeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(composer.value);
        composer.value = "";
      }
    },
  });

  mount(root, [
    el("div", { class: "channel-layout" }, [
      el("div", { class: "channel-main" }, [
        channelHeader(ch, ts),
        el("div", { class: "channel-messages", id: "channelMessages" },
          messages.length ? messages.map(m => renderMessage(m, d)) : [el("div", { class: "muted tiny" }, ["No messages yet."])]
        ),
        el("div", { class: "channel-composer" }, [
          composer,
          el("div", { class: "row spread" }, [
            el("div", { class: "row wrap" }, [
              typeSelector(),
              el("button", { class: "btn sm ghost", onClick: () => linkObject(composer) }, ["+ Link object"]),
              el("button", { class: "btn sm ghost", onClick: () => addChecklist(composer) }, ["+ Checklist"]),
              el("button", { class: "btn sm ghost", onClick: () => addDecision(composer) }, ["+ Decision"]),
              el("button", { class: "btn sm ghost", onClick: () => addMention(composer) }, ["@ Mention"]),
              el("button", { class: "btn sm ghost", onClick: () => addCodeBlock(composer) }, ["</> Code"]),
              el("button", { class: "btn sm ghost", onClick: () => addDataBlock(composer) }, ["▦ Data"]),
            ]),
            el("button", {
              class: "btn sm primary",
              disabled: !can("create") || ch.kind === "incident" && !can("incident.respond"),
              onClick: () => { send(composer.value); composer.value = ""; },
            }, ["Send"]),
          ]),
        ]),
      ]),
      renderThreadDrawer(ch, messages, d),
    ]),
  ]);

  function typeSelector() {
    const s = el("select", { class: "select sm", id: "msgType" });
    ["discussion","review","decision","handover","alarm"].forEach(t => {
      const o = document.createElement("option"); o.value = t; o.textContent = t; s.append(o);
    });
    return s;
  }

  function send(text) {
    if (!text.trim()) return;
    if (!can("create")) { toast("Read-only role cannot post", "warn"); return; }
    const type = document.getElementById("msgType")?.value || "discussion";
    const user = (state.data.users || []).find(u => u.role === state.ui.role) || state.data.users[0];
    const msg = {
      id: `M-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
      channelId: ch.id,
      authorId: user?.id || "U-1",
      ts: new Date().toISOString(),
      type,
      text: text.trim(),
      edits: [],
      deleted: false,
    };
    update(s => { s.data.messages.push(msg); });
    audit("message.post", ch.id, { messageId: msg.id });
    fanout(ch.id, "message", { kind: "channel", text: `New ${type} in #${ch.name}`, route: `/channel/${ch.id}` });
    notifyMentions({ text: msg.text, subject: ch.id, route: `/channel/${ch.id}`, actorId: msg.authorId });
    toast("Message posted", "success");
  }
}

function channelHeader(ch, ts) {
  const isFollow = isFollowing(ch.id);
  return el("div", { class: "row spread", style: { padding: "10px 16px", borderBottom: "1px solid var(--border)" } }, [
    el("div", {}, [
      el("div", { class: "strong" }, [`# ${ch.name}`]),
      el("div", { class: "tiny muted" }, [`${ts?.name || ""} · kind: ${ch.kind}`]),
    ]),
    el("div", { class: "row" }, [
      badge(ch.kind === "incident" ? "INCIDENT-LOCKED" : "LIVE", ch.kind === "incident" ? "danger" : "success"),
      el("button", { class: "btn sm", onClick: () => { isFollow ? unfollow(ch.id) : follow(ch.id); } }, [isFollow ? "Unfollow" : "Follow"]),
    ]),
  ]);
}

function renderMessage(m, d) {
  if (m.deleted) {
    return el("div", { class: "message" }, [
      el("div", { class: "avatar" }, ["–"]),
      el("div", { class: "body" }, [
        el("div", { class: "tiny muted" }, [`[message deleted] by ${m.deletedBy || "?"} at ${m.deletedAt ? new Date(m.deletedAt).toLocaleString() : ""}`]),
      ]),
    ]);
  }
  const author = (d.users || []).find(u => u.id === m.authorId);
  const bodyEls = [linkifyText(m.text, d), renderBlocks(m, d)];

  return el("div", { class: "message" }, [
    el("div", { class: "avatar" }, [author?.initials || (m.authorId === "system" ? "⚙" : "??")]),
    el("div", { class: "body" }, [
      el("div", { class: "head" }, [
        el("span", { class: "name" }, [author?.name || m.authorId]),
        el("span", { class: "ts" }, [new Date(m.ts).toLocaleString()]),
        el("span", { class: "type" }, [m.type]),
        (m.edits || []).length ? el("span", { class: "tiny muted" }, ["(edited)"]) : null,
        m.type === "decision" ? badge("DECISION", "purple") : null,
      ]),
      ...bodyEls,
      el("div", { class: "row wrap", style: { marginTop: "4px" } }, [
        el("button", { class: "btn sm ghost", onClick: () => convertToWorkItem(m) }, ["→ Work item"]),
        el("button", { class: "btn sm ghost", onClick: () => escalateToIncident(m) }, ["→ Incident"]),
        isOwn(m) && !m.deleted ? el("button", { class: "btn sm ghost", onClick: () => editMessage(m) }, ["Edit"]) : null,
        isOwn(m) && !m.deleted ? el("button", { class: "btn sm ghost", onClick: () => deleteMessage(m) }, ["Delete"]) : null,
      ]),
    ]),
  ]);
}

function isOwn(m) {
  const user = (state.data.users || []).find(u => u.role === state.ui.role);
  return user && m.authorId === user.id;
}

function renderBlocks(m, d) {
  const wrap = document.createDocumentFragment();
  // Checklist block: lines starting with "[ ]" or "[x]".
  const lines = (m.text || "").split("\n");
  const checklist = lines.filter(l => /^\s*\[( |x)\] /i.test(l));
  if (checklist.length) {
    const list = el("div", { class: "stack", style: { gap: "2px", marginTop: "4px" } });
    checklist.forEach((l, i) => {
      const done = /^\s*\[x\] /i.test(l);
      const text = l.replace(/^\s*\[( |x)\] /i, "");
      list.append(el("label", { class: "row", style: { gap: "6px" } }, [
        el("input", { type: "checkbox", checked: done, onChange: () => toggleCheckbox(m, i) }),
        el("span", { class: "small", style: { textDecoration: done ? "line-through" : "none" } }, [text]),
      ]));
    });
    wrap.append(list);
  }
  return wrap;
}

function toggleCheckbox(m, index) {
  const user = (state.data.users || []).find(u => u.role === state.ui.role);
  if (!user || m.authorId !== user.id) { if (!can("edit")) { toast("Only author or editor can toggle", "warn"); return; } }
  update(s => {
    const msg = s.data.messages.find(x => x.id === m.id);
    if (!msg) return;
    const lines = (msg.text || "").split("\n");
    let counter = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\[( |x)\] /i.test(lines[i])) {
        counter += 1;
        if (counter === index) {
          lines[i] = /^\s*\[x\]/i.test(lines[i])
            ? lines[i].replace(/^\s*\[x\] /i, "[ ] ")
            : lines[i].replace(/^\s*\[ \] /i, "[x] ");
        }
      }
    }
    msg.text = lines.join("\n");
    msg.edits = msg.edits || [];
    msg.edits.push({ ts: new Date().toISOString(), actor: s.ui.role, diff: "checklist-toggle:" + index });
  });
  audit("message.checklist.toggle", m.id, { index });
}

function linkifyText(text, d) {
  // Render markdown first (async, safe), then walk the DOM to swap object-ID
  // tokens for clickable chips. Both stages are XSS-safe (DOMPurify + our
  // own chip renderer).
  const md = renderMarkdown(text || "");
  // Observe once for the async swap-in; upgrade tokens to chips after render.
  queueMicrotask(() => upgradeTokens(md, d));
  new MutationObserver(() => upgradeTokens(md, d)).observe(md, { childList: true, subtree: true, characterData: true });
  md.classList.add("text");
  return md;
}

function upgradeTokens(root, d) {
  // 1) [OBJ-ID] → object chip.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const node of texts) {
    const v = node.nodeValue;
    if (!/\[[A-Z]+-[A-Z0-9-]+\]/.test(v)) continue;
    const frag = document.createDocumentFragment();
    v.split(/(\[[A-Z]+-[A-Z0-9-]+\])/g).forEach(tok => {
      const m = tok.match(/^\[([A-Z]+-[A-Z0-9-]+)\]$/);
      if (m) frag.append(chip(m[1], { onClick: () => jumpById(m[1], d) }));
      else if (tok) frag.append(document.createTextNode(tok));
    });
    node.parentNode.replaceChild(frag, node);
  }
  // 2) @user → user chip.
  highlightMentions(root, d.users || [], (u) =>
    chip("@" + (u.name || u.id), {
      kind: u.id,
      onClick: () => alert(`User ${u.id}\n${u.name}\nRole: ${u.role}`),
    })
  );
}

function jumpById(id, d) {
  if ((d.documents || []).some(x => x.id === id)) return navigate(`/doc/${id}`);
  if ((d.drawings || []).some(x => x.id === id)) return navigate(`/drawing/${id}`);
  if ((d.assets || []).some(x => x.id === id)) return navigate(`/asset/${id}`);
  if ((d.workItems || []).some(x => x.id === id)) {
    const w = (d.workItems || []).find(x => x.id === id);
    return navigate(`/work-board/${w.projectId}`);
  }
  if ((d.incidents || []).some(x => x.id === id)) return navigate(`/incident/${id}`);
  if ((d.revisions || []).some(x => x.id === id)) {
    const r = (d.revisions || []).find(x => x.id === id);
    return navigate(`/doc/${r.docId}`);
  }
  toast("Object not found in this workspace", "warn");
}

async function linkObject(composer) {
  const val = await prompt({
    title: "Link an object",
    label: "Object ID",
    placeholder: "DOC-1, AS-1, WI-101, REV-2-C, INC-4412",
  });
  if (!val) return;
  composer.value += (composer.value ? " " : "") + `[${val.trim()}]`;
  composer.focus();
}

function addChecklist(composer) {
  composer.value += (composer.value ? "\n" : "") + "[ ] item 1\n[ ] item 2";
  composer.focus();
}
function addDecision(composer) {
  // Decision markers are rendered via msgType=decision; this helper labels it.
  composer.value = (composer.value ? composer.value + "\n" : "") + "Decision: ";
  const sel = document.getElementById("msgType");
  if (sel) sel.value = "decision";
  composer.focus();
}

async function addMention(composer) {
  const users = state.data.users || [];
  const sel = select(users.map(u => ({ value: u.initials, label: `${u.initials} — ${u.name} (${u.role})` })));
  modal({
    title: "Mention a user",
    body: el("div", { class: "stack" }, [
      formRow("User", sel),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Insert", variant: "primary", onClick: () => {
        const u = resolveMention(sel.value, users);
        if (!u) return;
        composer.value += (composer.value ? " " : "") + `@${u.initials}`;
        composer.focus();
      }},
    ],
  });
}

async function addCodeBlock(composer) {
  const lang = (await prompt({ title: "Insert code block", label: "Language", defaultValue: "js", placeholder: "js, py, sql, json…" })) || "";
  const fenced = "\n```" + lang + "\n// your code\n```\n";
  composer.value += fenced;
  composer.focus();
}

function addDataBlock(composer) {
  // GitHub-flavored markdown table that marked + DOMPurify will render.
  const sample = "\n| key | value |\n| --- | --- |\n| sample | 1 |\n";
  composer.value += sample;
  composer.focus();
}

async function convertToWorkItem(m) {
  if (!can("create")) { toast("No permission", "warn"); return; }
  const title = await prompt({ title: "Convert to work item", label: "Title", defaultValue: (m.text || "").slice(0, 60) });
  if (!title) return;
  const ch = (state.data.channels || []).find(c => c.id === m.channelId);
  const ts = (state.data.teamSpaces || []).find(t => t.id === ch.teamSpaceId);
  const project = (state.data.projects || []).find(p => p.teamSpaceId === ts?.id) || (state.data.projects || [])[0];
  const id = "WI-" + Math.floor(Math.random()*900+100);
  update(s => {
    s.data.workItems.push({
      id, projectId: project.id, type: "Task", title,
      assigneeId: "U-1", status: "Open", severity: "medium",
      due: null, blockers: [], labels: [m.id],
      description: `From message ${m.id} in #${ch.name}.`,
    });
  });
  audit("message.convert.workitem", m.id, { workItemId: id });
  toast(`${id} created from message`, "success");
  navigate(`/work-board/${project.id}`);
}

async function escalateToIncident(m) {
  if (!can("create")) { toast("No permission", "warn"); return; }
  const title = await prompt({ title: "Escalate to incident", label: "Incident title", defaultValue: (m.text || "").slice(0, 60) });
  if (!title) return;
  const ch = (state.data.channels || []).find(c => c.id === m.channelId);
  const id = "INC-" + Math.floor(Math.random() * 9000 + 1000);
  update(s => {
    s.data.incidents.push({
      id, title, severity: "SEV-3", status: "active",
      assetId: null, commanderId: null, channelId: ch.id,
      startedAt: new Date().toISOString(),
      timeline: [{ ts: new Date().toISOString(), actor: s.ui.role, text: `Escalated from message ${m.id}.` }],
    });
  });
  audit("message.escalate.incident", m.id, { incidentId: id });
  toast(`${id} opened`, "danger");
  navigate(`/incident/${id}`);
}

function editMessage(m) {
  const ta = textarea({ value: m.text });
  modal({
    title: `Edit ${m.id}`,
    body: formRow("Text", ta),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: () => {
        update(s => {
          const x = s.data.messages.find(y => y.id === m.id);
          if (!x) return;
          x.edits = x.edits || [];
          x.edits.push({ ts: new Date().toISOString(), actor: s.ui.role, from: x.text, to: ta.value });
          x.text = ta.value;
        });
        audit("message.edit", m.id);
        toast("Saved", "success");
      }},
    ],
  });
}

async function deleteMessage(m) {
  const ok = await dangerAction({
    title: "Delete this message?",
    message: "The message will be hidden from the channel. The full text is retained in the audit log.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  update(s => {
    const x = s.data.messages.find(y => y.id === m.id);
    if (!x) return;
    x.deleted = true;
    x.deletedAt = new Date().toISOString();
    x.deletedBy = s.ui.role;
  });
  audit("message.delete", m.id);
}

function renderThreadDrawer(ch, messages, d) {
  const recent = messages.slice(-6).reverse();
  const decisions = messages.filter(m => m.type === "decision");
  return el("div", { class: "thread-drawer" }, [
    el("div", { class: "strong" }, ["Pinned objects"]),
    el("div", { class: "row wrap" }, [
      chip("#" + ch.name),
      ch.kind === "incident" ? chip("INC-4412", { kind: "incident", onClick: () => navigate("/incident/INC-4412") }) : null,
    ]),
    el("div", { class: "strong", style: { marginTop: "12px" } }, ["Decisions"]),
    decisions.length
      ? decisions.slice(-4).map(m => el("div", { class: "activity-row" }, [
          badge("DECISION", "purple"),
          el("span", { class: "small" }, [m.text.length > 40 ? m.text.slice(0, 40) + "…" : m.text]),
        ]))
      : [el("div", { class: "muted tiny" }, ["No decisions recorded."])],
    el("div", { class: "strong", style: { marginTop: "12px" } }, ["Recent"]),
    ...recent.map(m => el("div", { class: "activity-row" }, [
      badge(m.type, "info"),
      el("span", { class: "small" }, [(m.text || "").slice(0, 50)]),
    ])),
    el("div", { class: "strong", style: { marginTop: "12px" } }, ["AI assist"]),
    el("button", { class: "btn sm", onClick: () => navigate(`/ai?channel=${ch.id}`) }, ["Summarize unread →"]),
  ]);
}
