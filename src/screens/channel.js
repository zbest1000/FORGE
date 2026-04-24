import { el, mount, card, badge, chip } from "../core/ui.js";
import { state, update, getById, audit } from "../core/store.js";
import { navigate } from "../core/router.js";
import { can } from "../core/permissions.js";
import { toast } from "../core/ui.js";

export function renderChannel({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const ch = getById("channels", id);
  if (!ch) return mount(root, el("div", { class: "muted" }, ["Channel not found."]));

  const ts = getById("teamSpaces", ch.teamSpaceId);
  const messages = (d.messages || [])
    .filter(m => m.channelId === id)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const user = (d.users || []).find(u => u.role === state.ui.role) || d.users[0];

  const composer = el("textarea", {
    placeholder: `Message #${ch.name}...  (Shift+Enter for newline, Enter to send)`,
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
        el("div", { class: "row spread", style: { padding: "10px 16px", borderBottom: "1px solid var(--border)" } }, [
          el("div", {}, [
            el("div", { class: "strong" }, [`# ${ch.name}`]),
            el("div", { class: "tiny muted" }, [`${ts?.name || ""} · kind: ${ch.kind}`]),
          ]),
          el("div", { class: "row" }, [
            badge(ch.kind === "incident" ? "INCIDENT-LOCKED" : "LIVE", ch.kind === "incident" ? "danger" : "success"),
          ]),
        ]),
        el("div", { class: "channel-messages", id: "channelMessages" },
          messages.length
            ? messages.map(m => renderMessage(m, d))
            : [el("div", { class: "muted tiny" }, ["No messages yet."])]
        ),
        el("div", { class: "channel-composer" }, [
          composer,
          el("div", { class: "row spread" }, [
            el("div", { class: "row wrap" }, [
              typeSelector(),
              el("button", { class: "btn sm ghost", onClick: linkObject }, ["+ Link object"]),
            ]),
            el("button", {
              class: "btn sm primary",
              disabled: !can("create"),
              onClick: () => { send(composer.value); composer.value = ""; },
            }, ["Send"]),
          ]),
        ]),
      ]),
      renderThreadDrawer(ch, messages, d),
    ]),
  ]);

  function typeSelector() {
    const select = el("select", { class: "select sm", id: "msgType" });
    ["discussion","review","decision","handover","alarm"].forEach(t => {
      const opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      select.append(opt);
    });
    return select;
  }

  function send(text) {
    if (!text.trim()) return;
    if (!can("create")) { toast("Read-only role cannot post", "warn"); return; }
    const type = document.getElementById("msgType")?.value || "discussion";
    const msg = {
      id: `M-${Date.now().toString(36)}`,
      channelId: ch.id,
      authorId: user?.id || "U-1",
      ts: new Date().toISOString(),
      type,
      text: text.trim(),
    };
    update(s => { s.data.messages.push(msg); });
    audit("message.post", ch.id, { messageId: msg.id });
    toast("Message posted", "success");
  }

  function linkObject() {
    const val = window.prompt("Link an object — enter ID (DOC-1, AS-1, WI-101, REV-2-C, INC-4412):");
    if (!val) return;
    composer.value += (composer.value ? " " : "") + `[${val.trim()}]`;
    composer.focus();
  }
}

function renderMessage(m, d) {
  const author = (d.users || []).find(u => u.id === m.authorId);
  const text = linkifyText(m.text, d);
  return el("div", { class: "message" }, [
    el("div", { class: "avatar" }, [author?.initials || "??"]),
    el("div", { class: "body" }, [
      el("div", { class: "head" }, [
        el("span", { class: "name" }, [author?.name || m.authorId]),
        el("span", { class: "ts" }, [new Date(m.ts).toLocaleString()]),
        el("span", { class: "type" }, [m.type]),
      ]),
      el("div", { class: "text" }, [text]),
      m.attachments?.length
        ? el("div", { class: "attachments" }, m.attachments.map(a => chip(a.id, { kind: a.kind, onClick: () => jumpToAttachment(a) })))
        : null,
    ]),
  ]);
}

function jumpToAttachment(a) {
  if (a.kind === "document") navigate(`/doc/${a.id}`);
  if (a.kind === "drawing")  navigate(`/drawing/${a.id}`);
  if (a.kind === "asset")    navigate(`/asset/${a.id}`);
}

function linkifyText(text, d) {
  // Replace tokens like [DOC-1] with clickable chips.
  const tokens = text.split(/(\[[A-Z]+-[A-Z0-9-]+\])/g);
  const frag = document.createDocumentFragment();
  tokens.forEach(t => {
    const m = t.match(/^\[([A-Z]+-[A-Z0-9-]+)\]$/);
    if (m) {
      const id = m[1];
      frag.append(chip(id, { onClick: () => jumpById(id, d) }));
    } else {
      frag.append(document.createTextNode(t));
    }
  });
  return frag;
}

function jumpById(id, d) {
  if ((d.documents || []).some(x => x.id === id)) return navigate(`/doc/${id}`);
  if ((d.drawings || []).some(x => x.id === id))  return navigate(`/drawing/${id}`);
  if ((d.assets || []).some(x => x.id === id))    return navigate(`/asset/${id}`);
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

function renderThreadDrawer(ch, messages, d) {
  const recent = messages.slice(-5).reverse();
  return el("div", { class: "thread-drawer" }, [
    el("div", { class: "strong" }, ["Pinned objects"]),
    el("div", { class: "row wrap" }, [
      chip("#" + ch.name),
      ch.kind === "incident" ? chip("INC-4412", { kind: "incident", onClick: () => navigate("/incident/INC-4412") }) : null,
    ]),
    el("div", { class: "strong", style: { marginTop: "12px" } }, ["Recent threads"]),
    ...recent.map(m => el("div", { class: "activity-row" }, [
      badge(m.type, "info"),
      el("span", { class: "small" }, [m.text.length > 50 ? m.text.slice(0, 48) + "…" : m.text]),
    ])),
    el("div", { class: "strong", style: { marginTop: "12px" } }, ["AI assist"]),
    el("div", { class: "tiny muted" }, ["Summarize unread and draft a reply in AI workspace."]),
    el("button", { class: "btn sm", onClick: () => navigate("/ai") }, ["Open AI →"]),
  ]);
}
