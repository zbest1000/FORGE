// @user mention parser + notification fan-out (spec §5.3, §6.1).
//
// Recognises tokens of the form `@<initials-or-name>` in message text,
// resolves them against the user directory by initials (case-insensitive),
// emits a notification per resolved user, and surfaces them in `inbox`.

import { state, update } from "./store.js";
import { audit } from "./audit.js";

// Token format: @ followed by 2-24 chars (letters, digits, dot, hyphen).
const TOKEN_RE = /(^|[\s\(\[\{])@([A-Za-z][A-Za-z0-9._-]{0,23})/g;

// Resolve a token (without the @) to a user by:
//   - exact id (e.g. U-3)
//   - initials (case-insensitive)
//   - last-name match (case-insensitive)
//   - first.last or first-last
export function resolveMention(token, users) {
  const t = String(token || "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  // Direct id.
  let u = users.find(x => x.id?.toLowerCase() === lower);
  if (u) return u;
  // Initials (e.g. JS, RO).
  u = users.find(x => (x.initials || "").toLowerCase() === lower);
  if (u) return u;
  // Last name token.
  u = users.find(x => {
    const last = (x.name || "").split(/\s+/).pop().toLowerCase();
    return last && last === lower;
  });
  if (u) return u;
  // first.last or first-last (collapse repeated separators).
  u = users.find(x => {
    const norm = (x.name || "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
    const flat = norm; // dot-separated
    const flat2 = norm.replace(/\./g, "-");
    return flat === lower || flat2 === lower;
  });
  return u || null;
}

/**
 * Return the list of user-ids referenced by @mentions in `text`.
 * Tokens that don't resolve are ignored.
 */
export function extractMentions(text, users) {
  if (!text) return [];
  const found = new Set();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const u = resolveMention(m[2], users || []);
    if (u) found.add(u.id);
  }
  return [...found];
}

/**
 * Emit a notification per mentioned user. `subject` should be the
 * channel/object id where the mention occurred. `route` deep-links to it.
 * Mentioning yourself is a no-op.
 */
export function notifyMentions({ text, subject, route, actorId }) {
  const users = state.data?.users || [];
  const ids = extractMentions(text, users);
  if (!ids.length) return [];
  const ts = new Date().toISOString();
  update(s => {
    s.data.notifications = s.data.notifications || [];
    for (const uid of ids) {
      if (uid === actorId) continue;
      s.data.notifications.unshift({
        id: "N-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        ts,
        kind: "mention",
        text: snippet(text),
        route,
        user: uid,
        subject,
      });
    }
    if (s.data.notifications.length > 200) s.data.notifications.length = 200;
  });
  audit("message.mention", subject, { count: ids.length, mentioned: ids });
  return ids;
}

function snippet(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  return t.length > 100 ? t.slice(0, 97) + "…" : t;
}

/**
 * Highlight `@user` tokens in a DOM subtree by replacing matching text
 * nodes with chips. Used after marked+DOMPurify renders the message.
 */
export function highlightMentions(root, users, makeChip) {
  if (!root || !root.childNodes) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const node of texts) {
    if (!/@[A-Za-z]/.test(node.nodeValue)) continue;
    const v = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(v)) !== null) {
      const before = v.slice(last, m.index + (m[1] ? m[1].length : 0));
      if (before) frag.append(document.createTextNode(before));
      const u = resolveMention(m[2], users);
      if (u) frag.append(makeChip(u));
      else frag.append(document.createTextNode("@" + m[2]));
      last = m.index + m[0].length;
    }
    if (last < v.length) frag.append(document.createTextNode(v.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}
