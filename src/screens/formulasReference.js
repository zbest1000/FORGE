// Formula reference page (/formulas).
//
// Renders every BUILTINS entry from src/core/formulas.js as a
// searchable, runnable reference card so operators authoring a
// formula field have the function library + a live "try it" sandbox
// in one place. Mirrors Asana's formula docs page in spirit but
// stays inside the FORGE shell so users don't have to leave the app.

import { el, mount, card, badge, formRow, input, textarea } from "../core/ui.js";
import { BUILTINS, evaluate } from "../core/formulas.js";

export function renderFormulasReference() {
  const root = document.getElementById("screenContainer");
  if (!root) return;

  // Group functions by category for the index sidebar.
  const byCategory = {};
  for (const [name, def] of Object.entries(BUILTINS)) {
    const cat = def.category || "Other";
    (byCategory[cat] = byCategory[cat] || []).push({ name, ...def });
  }
  const categories = Object.keys(byCategory).sort();

  mount(root, [
    el("div", { class: "row spread mb-3" }, [
      el("div", {}, [
        el("h2", { class: "m-0" }, ["Formula reference"]),
        el("div", { class: "tiny muted" }, [
          "Every built-in function you can use in a formula field on a work item, document, or asset. ",
          "Each card runs live — type into the sandbox to see the result.",
        ]),
      ]),
      el("div", { class: "row gap-2" }, [
        el("a", {
          class: "btn sm",
          href: "#/work",
        }, ["Back to Activity"]),
      ]),
    ]),

    sandboxCard(),

    el("div", { class: "two-col" }, [
      // Left: category jump-list.
      card("Categories", el("div", { class: "stack" }, categories.map(cat =>
        el("a", {
          class: "btn sm ghost",
          href: `#category-${cat.toLowerCase()}`,
          style: { justifyContent: "flex-start" },
        }, [`${cat} (${byCategory[cat].length})`])
      ))),
      // Right: doc-style intro.
      card("How formulas work", el("div", { class: "stack small" }, [
        el("p", {}, [
          "A formula is a single expression that resolves to a value. The expression can reference fields on the row (",
          el("code", {}, ["due"]),
          ", ",
          el("code", {}, ["assignee"]),
          ", ",
          el("code", {}, ["severity"]),
          ", etc.) and call functions from the library on this page.",
        ]),
        el("p", {}, [
          "Operators: ",
          el("code", {}, ["+ - * / % == != < <= > >= && || ??"]),
          ". Strings can be concatenated with ",
          el("code", {}, ["+"]),
          " or with ",
          el("code", {}, ["concat()"]),
          ".",
        ]),
        el("p", {}, [
          "Errors render inline next to the offending cell — they never crash the screen. Fix the expression and the value reappears.",
        ]),
      ])),
    ]),

    ...categories.map(cat => categorySection(cat, byCategory[cat])),
  ]);
}

function sandboxCard() {
  // Tiny live editor — operators paste an expression here and see
  // the output instantly. The scope mirrors what a work-item formula
  // sees at runtime so operators can prototype before pasting into
  // a real field.
  const input = textarea({
    rows: 3,
    placeholder: "daysUntilDue(due)",
    style: { fontFamily: "var(--font-mono)" },
  });
  const output = el("div", { class: "mono small" }, ["—"]);
  const scopeFields = el("div", { class: "row wrap gap-2" }, [
    fieldRow("title", "Scan cycle >500ms on PLC-A2"),
    fieldRow("severity", "medium"),
    fieldRow("due", new Date(Date.now() + 3 * 86400_000).toISOString()),
    fieldRow("assignee", "U-1"),
  ]);
  const scope = {};

  function readScope() {
    scope.title = scopeFields.querySelector('[data-key="title"]')?.value || "";
    scope.severity = scopeFields.querySelector('[data-key="severity"]')?.value || "";
    scope.due = scopeFields.querySelector('[data-key="due"]')?.value || "";
    scope.assignee = scopeFields.querySelector('[data-key="assignee"]')?.value || "";
  }

  function rerun() {
    readScope();
    const result = evaluate(input.value, scope);
    if (result.ok) {
      output.replaceChildren(el("span", { class: "success-text" }, [String(result.value)]));
    } else {
      output.replaceChildren(el("span", { class: "danger-text" }, [`✕ ${result.error}`]));
    }
  }

  input.addEventListener("input", rerun);
  scopeFields.addEventListener("input", rerun);
  setTimeout(rerun, 0);

  return card("Sandbox", el("div", { class: "stack" }, [
    el("div", { class: "tiny muted" }, ["Scope (the row's fields):"]),
    scopeFields,
    el("div", { class: "tiny muted mt-2" }, ["Expression:"]),
    input,
    el("div", { class: "row gap-2 mt-2" }, [
      el("span", { class: "tiny muted" }, ["Result:"]),
      output,
    ]),
  ]), { subtitle: "Type a formula — it runs live as you type" });
}

function fieldRow(key, defaultValue) {
  const inp = input({ value: defaultValue });
  inp.dataset.key = key;
  inp.style.maxWidth = "200px";
  return el("label", { class: "stack", style: { gap: "2px" } }, [
    el("span", { class: "tiny muted" }, [key]),
    inp,
  ]);
}

function categorySection(cat, items) {
  return el("section", { id: `category-${cat.toLowerCase()}`, class: "stack mt-4" }, [
    el("h3", { class: "m-0" }, [cat]),
    el("div", { class: "card-grid" }, items.map(fnCard)),
  ]);
}

function fnCard(def) {
  const examples = (def.examples || []).map(([expr, note]) =>
    el("div", { class: "small mono" }, [
      el("span", { class: "accent-text" }, [expr]),
      note ? el("span", { class: "muted" }, [`  → ${note}`]) : null,
    ])
  );
  return card(
    el("span", { class: "mono" }, [def.signature]),
    el("div", { class: "stack" }, [
      el("div", { class: "small" }, [def.description]),
      examples.length > 0
        ? el("div", { class: "stack mt-2", style: { gap: "4px" } }, [
            el("div", { class: "tiny muted" }, ["Examples"]),
            ...examples,
          ])
        : null,
    ]),
    { subtitle: badge(def.category, "info") },
  );
}

export default { renderFormulasReference };
