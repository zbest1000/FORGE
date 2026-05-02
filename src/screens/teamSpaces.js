import { el, mount, card, badge } from "../core/ui.js";
import { state, getById } from "../core/store.js";
import { navigate } from "../core/router.js";
import { helpHint, helpLinkChip } from "../core/help.js";

export function renderTeamSpacesIndex() {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  mount(root, [
    el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
      el("div", {}, [
        el("h2", { style: { display: "inline-flex", alignItems: "center", margin: 0, fontSize: "18px" } }, [
          "Team spaces", helpHint("forge.spaces"),
        ]),
        el("div", { class: "tiny muted" }, ["A workspace primitive containing channels, projects, members, and shared docs."]),
        el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
          helpLinkChip("forge.spaces", "Team spaces"),
          helpLinkChip("forge.channels", "Channels"),
        ]),
      ]),
    ]),
    el("div", { class: "card-grid" }, (d.teamSpaces || []).map(ts => {
      const channels = (d.channels || []).filter(c => c.teamSpaceId === ts.id);
      const projects = (d.projects || []).filter(p => p.teamSpaceId === ts.id);
      return card(ts.name, el("div", { class: "stack" }, [
        el("div", { class: "tiny muted" }, [ts.summary]),
        el("div", { class: "row wrap" }, [
          badge(`${ts.memberIds?.length || 0} members`, "info"),
          badge(`${channels.length} channels`, ""),
          badge(`${projects.length} projects`, ""),
        ]),
      ]), {
        actions: [el("button", { class: "btn sm primary", onClick: () => navigate(`/team-space/${ts.id}`) }, ["Open"])],
      });
    })),
  ]);
}

export function renderTeamSpace({ id }) {
  const root = document.getElementById("screenContainer");
  const d = state.data;
  const ts = getById("teamSpaces", id);
  if (!ts) return mount(root, el("div", { class: "muted" }, ["Team space not found."]));

  const channels = (d.channels || []).filter(c => c.teamSpaceId === id);
  const projects = (d.projects || []).filter(p => p.teamSpaceId === id);
  const docs     = (d.documents || []).filter(x => x.teamSpaceId === id);
  const members  = (d.users || []).filter(u => ts.memberIds?.includes(u.id));

  mount(root, [
    card(el("span", { style: { display: "inline-flex", alignItems: "center" } }, [ts.name, helpHint("forge.spaces")]), el("div", { class: "stack" }, [
      el("div", { class: "muted" }, [ts.summary]),
      el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
        helpLinkChip("forge.spaces", "Team spaces"),
        helpLinkChip("forge.channels", "Channels"),
      ]),
    ]), { subtitle: `ID ${ts.id}` }),
    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card(`Channels (${channels.length})`, el("div", { class: "stack" }, channels.map(c =>
        el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/channel/${c.id}`) }, [
          badge(c.kind, "info"),
          el("span", {}, [`#${c.name}`]),
          c.unread ? badge(`${c.unread} new`, "warn") : null,
        ])
      ))),
      card(`Projects (${projects.length})`, el("div", { class: "stack" }, projects.map(p =>
        el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/work-board/${p.id}`) }, [
          badge(p.status, p.status === "active" ? "success" : "info"),
          el("span", {}, [p.name]),
          el("span", { class: "tiny muted" }, [p.id]),
        ])
      ))),
    ]),
    el("div", { class: "two-col", style: { marginTop: "16px" } }, [
      card(`Docs (${docs.length})`, el("div", { class: "stack" }, docs.map(doc =>
        el("button", { class: "activity-row", type: "button", onClick: () => navigate(`/doc/${doc.id}`) }, [
          badge(doc.discipline, "info"),
          el("span", {}, [doc.name]),
          el("span", { class: "tiny muted" }, [doc.id]),
        ])
      ))),
      card(`Members (${members.length})`, el("div", { class: "stack" }, members.map(u =>
        el("div", { class: "activity-row" }, [
          el("span", { class: "mono tiny" }, [u.id]),
          el("span", {}, [u.name]),
          badge(u.role, ""),
        ])
      ))),
    ]),
  ]);
}
