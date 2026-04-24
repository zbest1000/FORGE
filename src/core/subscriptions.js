// Object watch/follow model (spec §6.1 "Watch/follow model for notifications
// by object and status transitions").
//
// Each subscription is `{ id, subject, user, events: ["update","status","transition","message"], created_at }`.

import { state, update } from "./store.js";
import { audit } from "./audit.js";

export function follow(subject, userId = null, events = ["update","status","transition","message"]) {
  const uid = userId || currentUser();
  const existing = find(subject, uid);
  if (existing) return existing;
  const sub = {
    id: "SUB-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
    subject: String(subject),
    user: uid,
    events,
    created_at: new Date().toISOString(),
  };
  update(s => { s.data.subscriptions = s.data.subscriptions || []; s.data.subscriptions.push(sub); });
  audit("subscription.follow", subject, { subscriptionId: sub.id });
  return sub;
}

export function unfollow(subject, userId = null) {
  const uid = userId || currentUser();
  update(s => {
    s.data.subscriptions = (s.data.subscriptions || []).filter(x => !(x.subject === subject && x.user === uid));
  });
  audit("subscription.unfollow", subject, {});
}

export function isFollowing(subject, userId = null) {
  const uid = userId || currentUser();
  return !!find(subject, uid);
}

export function followers(subject) {
  return (state.data?.subscriptions || []).filter(x => x.subject === subject).map(x => x.user);
}

/**
 * Dispatch an event for a subject to all subscribers. Produces a notification
 * in `state.data.notifications` and returns the list of affected users.
 */
export function fanout(subject, eventType, { text, route, kind } = {}) {
  const subs = (state.data?.subscriptions || []).filter(x => x.subject === subject && x.events.includes(eventType));
  if (!subs.length) return [];
  const ts = new Date().toISOString();
  update(s => {
    for (const sub of subs) {
      s.data.notifications = s.data.notifications || [];
      s.data.notifications.unshift({
        id: "N-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        ts,
        kind: kind || eventType,
        text: text || `${subject} ${eventType}`,
        route: route || null,
        user: sub.user,
        subject,
      });
      if (s.data.notifications.length > 100) s.data.notifications.length = 100;
    }
  });
  return subs.map(s => s.user);
}

function currentUser() {
  // The prototype uses role-based identity in the demo. A real user id lookup
  // would use the auth context.
  const u = (state.data?.users || []).find(u => u.role === state.ui.role);
  return u?.id || "U-1";
}

function find(subject, user) {
  return (state.data?.subscriptions || []).find(x => x.subject === subject && x.user === user);
}
