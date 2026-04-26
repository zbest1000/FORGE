---
name: enterprise-ux-audit
description: Use when an agent must audit FORGE's full UI/UX, information architecture, design system, enterprise readiness, accessibility, or product workflow direction. Produces code-grounded findings and developer-ready tasks for making FORGE cleaner, calmer, more spacious, and enterprise-grade.
---

# Enterprise UX Audit Skill

Use this skill when reviewing or redesigning FORGE's product experience. The goal is not to preserve the current dense industrial-dashboard direction. The goal is to guide FORGE toward a mature enterprise SaaS experience for engineering, industrial, construction, manufacturing, and operations collaboration.

## Product direction

FORGE should feel closer to Linear, Notion, Asana, Jira, GitHub, Figma, ServiceNow, Microsoft 365, Siemens Industrial Edge, and mature document-control platforms than to a SCADA screen, engineering database, or developer-only tool.

Apply:

- Enterprise clarity over technical density.
- Progressive disclosure over overloaded screens.
- Role-based defaults over one-size-fits-all dashboards.
- Clean workflows over feature-heavy pages.
- Contextual detail over permanent clutter.
- Search, command palette, and drill-down navigation over crowded menus.
- Calm visual hierarchy over excessive badges.
- Strong document-control and audit UX without making the UI feel like compliance software.
- Industrial credibility without old-school industrial UI density.
- WCAG, keyboard, tablet, and field-use expectations.

## Required project files to inspect

Start with the runbook at `.cursor/skills/runbook.md`, then inspect:

- `README.md`, `docs/SERVER.md`, `PRODUCT_SPEC.md`
- `app.js`, `index.html`, `styles.css`
- `src/shell/rail.js`, `src/shell/header.js`, `src/shell/leftPanel.js`, `src/shell/contextPanel.js`, `src/shell/dock.js`
- `src/core/ui.js`, `src/core/router.js`, `src/core/screens-registry.js`, `src/core/permissions.js`, `src/core/groups.js`, `src/core/store.js`, `src/core/api.js`
- `src/data/seed.js`, `src/data/uns-seed.js`
- Every file in `src/screens/`
- `server/main.js`, `server/db.js`, `server/auth.js`, `server/acl.js`, `server/audit.js`, `server/routes/*`, `server/graphql/*`, `server/connectors/*`

## Audit checklist

Map the actual implementation before making recommendations:

1. Routes and top-level modules from `app.js`.
2. Global shell and navigation from `src/shell/*`.
3. Screen density and workflows from `src/screens/*`.
4. Tokens, layout rules, component classes, responsive behavior, and hardcoded values from `styles.css`.
5. Shared UI primitives from `src/core/ui.js`.
6. Role, capability, portal, route, and asset visibility from `src/core/permissions.js` and `src/core/groups.js`.
7. Server API, data model, auditability, AI, integrations, and auth from `server/*`.
8. Seed/demo behavior and local storage behavior from `src/data/seed.js` and `src/core/store.js`.

## Required review lenses

Use these lenses and always connect findings to code locations:

- Information architecture and workspace model.
- Navigation, shell, breadcrumbs, command palette, search, context panels.
- Page density and progressive disclosure.
- Visual hierarchy: titles, actions, badges, metadata, tables, panels.
- Role-based dashboards for executives, engineering managers, project managers, engineers, field technicians, admins, integration admins, vendors, clients, and auditors.
- Document, drawing, revision, markup, approval, transmittal, and audit UX.
- Work management: boards, tables, punch items, RFIs, dependencies, bulk edit.
- Industrial and asset UX: MQTT, OPC UA, UNS, i3X, live/stale/simulated data, diagnostics.
- Incident command UX.
- Integration admin UX.
- Governed AI workspace UX.
- Admin, SSO, RBAC, ABAC, retention, audit logs, policy violations, security settings.
- Accessibility, responsive layout, tablet, and field-mode behavior.
- Component refactor opportunities.
- UX, safety, operational, and enterprise adoption risk register.

## Deliverable format

Produce or update `docs/ENTERPRISE_UX_REDESIGN_AUDIT.md` with these sections:

A. Executive Summary
B. Product Experience Diagnosis
C. Application Map
D. Current Strengths
E. Major UX Problems
F. Screen-by-Screen Audit
G. Workflow Audit
H. Recommended Enterprise Information Architecture
I. Recommended Design System
J. Component Refactor Plan
K. Industrial and Engineering UX Recommendations
L. Accessibility and Responsive Review
M. Risk Register
N. Prioritized Roadmap
O. Developer-Ready Task List

## Task quality rules

Developer tasks must include:

- Task
- File/component
- Why it matters
- Suggested fix
- Priority
- Effort

Avoid generic design advice. Every recommendation must name concrete files, components, routes, or workflows.

## Current baseline report

Use `docs/ENTERPRISE_UX_REDESIGN_AUDIT.md` as the current baseline. When code changes materially, update the report in the same PR.
