// Group membership + portal/route visibility.
//
// Groups can nest (parentId). Membership is inherited downward when checking
// visibility: a member of `G-scada` is implicitly in its parent `G-automation`
// and grandparent `G-engineering`.
//
// Portals declare the groupIds (any-of) that may see them. A user who belongs
// to none of the declared groups will not see the portal in the Hub or rail.
// Organization Owners (super-admin role) always see everything.

import { state } from "./store.js";

export const PORTALS = [
  {
    id: "hub",
    label: "Hub",
    icon: "🏛",
    description: "Open the FORGE Hub — your home dashboard.",
    accent: "#38bdf8",
    routes: ["/hub"],
    items: [
      { icon: "🏠", label: "Hub",    route: "/hub" },
    ],
    groups: ["*"],
  },
  {
    id: "business",
    label: "Business",
    icon: "💼",
    description: "ERP, procurement, approvals, and finance dashboards.",
    accent: "#a78bfa",
    routes: ["/erp", "/approvals", "/dashboards", "/integrations/erp"],
    items: [
      { icon: "🏠", label: "Home",        route: "/home" },
      { icon: "📥", label: "Inbox",       route: "/inbox" },
      { icon: "🔎", label: "Search",      route: "/search" },
      { icon: "✅", label: "Approvals",   route: "/approvals" },
      { icon: "📊", label: "Dashboards",  route: "/dashboards" },
      { icon: "🏭", label: "ERP",         route: "/integrations/erp" },
      { icon: "🤖", label: "AI",          route: "/ai" },
    ],
    groups: ["G-business","G-mgmt","G-erp"],
  },
  {
    id: "management",
    label: "Management",
    icon: "📈",
    description: "Projects, team spaces, KPIs, and approvals oversight.",
    accent: "#22c55e",
    routes: ["/projects", "/team-spaces", "/dashboards", "/approvals"],
    items: [
      { icon: "🏠", label: "Home",       route: "/home" },
      { icon: "🗂",  label: "Spaces",    route: "/team-spaces" },
      { icon: "🎯", label: "Projects",   route: "/projects" },
      { icon: "✅", label: "Approvals",  route: "/approvals" },
      { icon: "📊", label: "Dashboards", route: "/dashboards" },
      { icon: "📥", label: "Inbox",      route: "/inbox" },
      { icon: "🔎", label: "Search",     route: "/search" },
    ],
    groups: ["G-mgmt","G-business"],
  },
  {
    id: "engineering",
    label: "Engineering",
    icon: "📐",
    description: "Documents, drawings, revisions, and design work.",
    accent: "#60a5fa",
    routes: ["/docs", "/drawings", "/projects", "/team-spaces"],
    items: [
      { icon: "🏠", label: "Home",      route: "/home" },
      { icon: "🗂",  label: "Spaces",   route: "/team-spaces" },
      { icon: "🎯", label: "Projects", route: "/projects" },
      { icon: "📑", label: "Docs",     route: "/docs" },
      { icon: "📐", label: "Drawings", route: "/drawings" },
      { icon: "⚙️", label: "Assets",   route: "/assets" },
      { icon: "✅", label: "Approvals",route: "/approvals" },
      { icon: "🤖", label: "AI",       route: "/ai" },
    ],
    groups: ["G-engineering","G-eng","G-automation","G-scada"],
  },
  {
    id: "automation",
    label: "Industrial Operations Data",
    icon: "🛰",
    description: "i3X / Unified Namespace, MQTT, OPC UA, telemetry & assets.",
    accent: "#f59e0b",
    routes: ["/i3x", "/uns", "/integrations/mqtt", "/integrations/opcua", "/assets"],
    items: [
      { icon: "🏠", label: "Home",     route: "/home" },
      { icon: "🌐", label: "UNS",      route: "/uns" },
      { icon: "🧩", label: "i3X",      route: "/i3x" },
      { icon: "⚙️", label: "Assets",   route: "/assets" },
      { icon: "🛰",  label: "MQTT",    route: "/integrations/mqtt" },
      { icon: "🔌", label: "OPC UA",   route: "/integrations/opcua" },
      { icon: "🚨", label: "Incidents",route: "/incidents" },
      { icon: "📊", label: "Dashboards", route: "/dashboards" },
    ],
    groups: ["G-automation","G-scada","G-engineering","G-eng"],
  },
  {
    id: "notes",
    label: "Notes & Docs",
    icon: "🗒",
    description: "Notion-style notebook of internal docs, SOPs, and channels.",
    accent: "#38bdf8",
    routes: ["/docs", "/team-spaces", "/channel"],
    items: [
      { icon: "📑", label: "Docs",       route: "/docs" },
      { icon: "🗂",  label: "Spaces",   route: "/team-spaces" },
      { icon: "📥", label: "Inbox",     route: "/inbox" },
      { icon: "🔎", label: "Search",    route: "/search" },
      { icon: "🤖", label: "AI",        route: "/ai" },
    ],
    groups: ["*"],
  },
  {
    id: "admin",
    label: "Admin & IT",
    icon: "🛡",
    description: "Server status, MQTT broker, audit, RBAC, integrations.",
    accent: "#ef4444",
    routes: ["/admin", "/integrations", "/integrations/mqtt"],
    items: [
      { icon: "🛡",  label: "Admin",        route: "/admin" },
      { icon: "🔌", label: "Integrations", route: "/integrations" },
      { icon: "🛰",  label: "MQTT",        route: "/integrations/mqtt" },
      { icon: "🔌", label: "OPC UA",       route: "/integrations/opcua" },
      { icon: "📊", label: "Dashboards",   route: "/dashboards" },
    ],
    groups: ["G-it"],
  },
];

export function listGroups() {
  return state.data?.groups || [];
}

export function getGroup(id) {
  return listGroups().find(g => g.id === id) || null;
}

/**
 * Walk a group's parent chain. Returns the group ids the user effectively
 * belongs to (direct memberships + every ancestor of each direct group).
 */
export function effectiveGroupIds(userId) {
  if (!userId) return [];
  const all = listGroups();
  const direct = all.filter(g => (g.memberIds || []).includes(userId)).map(g => g.id);
  const set = new Set(direct);
  const byId = Object.fromEntries(all.map(g => [g.id, g]));
  for (const id of direct) {
    let cur = byId[id]?.parentId;
    while (cur && !set.has(cur)) { set.add(cur); cur = byId[cur]?.parentId; }
  }
  return [...set];
}

/**
 * The "current viewer" — server user when signed in, otherwise the
 * `currentUserId` set in the seed (so demo mode still has an identity).
 */
export function currentUserId() {
  const su = state.server?.user;
  if (su?.id) return su.id;
  return state.data?.currentUserId || null;
}

export function currentUser() {
  const id = currentUserId();
  if (!id) return null;
  const local = (state.data?.users || []).find(u => u.id === id);
  if (local) return local;
  // Server user shape — synthesize a thin record so callers can still read
  // .name / .role.
  const su = state.server?.user;
  return su ? { id: su.id, name: su.name || su.email, role: su.role, initials: (su.name || su.email || "?").slice(0,2).toUpperCase(), groupIds: [] } : null;
}

/**
 * Effective role: prefer the dropdown override (state.ui.role) so the demo's
 * role switcher keeps working, but fall back to the user's stored role.
 */
export function currentRole() {
  return state.ui.role || currentUser()?.role || "Viewer/Auditor";
}

export function isOrgOwner() {
  return currentRole() === "Organization Owner";
}

/**
 * True if the current viewer can see the given portal id.
 */
export function canSeePortal(portalId) {
  const p = PORTALS.find(x => x.id === portalId);
  if (!p) return false;
  if (p.groups.includes("*")) return true;
  if (isOrgOwner()) return true;
  const eff = new Set(effectiveGroupIds(currentUserId()));
  return p.groups.some(gid => eff.has(gid));
}

export function visiblePortals() {
  return PORTALS.filter(p => canSeePortal(p.id));
}

/**
 * Route-level group gating. Mirrors portal `groups` so a user without the
 * Industrial Automation group can't reach `/i3x` even via direct hash, etc.
 *
 * Returns null if the route is unrestricted, or an array of groupIds (any-of)
 * required to view.
 */
const ROUTE_GROUPS = {
  "/i3x":                 ["G-automation","G-scada","G-engineering","G-eng"],
  "/uns":                 ["G-automation","G-scada","G-engineering","G-eng"],
  "/integrations":        ["G-it","G-automation","G-erp"],
  "/integrations/mqtt":   ["G-it","G-automation","G-scada"],
  "/integrations/opcua":  ["G-it","G-automation","G-scada"],
  "/integrations/erp":    ["G-it","G-business","G-erp","G-mgmt"],
  "/admin":               ["G-it"],
};

export function canAccessRoute(route) {
  if (isOrgOwner()) return true;
  // Match longest prefix.
  const keys = Object.keys(ROUTE_GROUPS).sort((a,b) => b.length - a.length);
  const hit = keys.find(k => route === k || route.startsWith(k + "/"));
  if (!hit) return true;
  const eff = new Set(effectiveGroupIds(currentUserId()));
  return ROUTE_GROUPS[hit].some(g => eff.has(g));
}

/**
 * True if the asset is assigned to the viewer or to one of their groups
 * (or it has no assignment at all). Assets without `assignedUserId` and
 * `assignedGroupId` are considered unassigned and visible to everyone.
 */
export function canSeeAsset(asset) {
  if (!asset) return false;
  if (isOrgOwner()) return true;
  if (!asset.assignedUserId && !asset.assignedGroupId) return true;
  const uid = currentUserId();
  if (asset.assignedUserId && asset.assignedUserId === uid) return true;
  if (asset.assignedGroupId) {
    const eff = new Set(effectiveGroupIds(uid));
    if (eff.has(asset.assignedGroupId)) return true;
  }
  return false;
}

/** Get the `?portal=...` value from the URL hash (stripped of the leading `#`). */
export function currentPortalId() {
  try {
    const raw = location.hash.replace(/^#/, "");
    const q = raw.split("?")[1];
    if (!q) return null;
    const sp = new URLSearchParams(q);
    const id = sp.get("portal");
    return id || null;
  } catch { return null; }
}

export function portalById(id) {
  return PORTALS.find(p => p.id === id) || null;
}
