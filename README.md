# FORGE
Federated Operations, Research, Governance, and Engineering.

## What is in this repository
- `PRODUCT_SPEC.md`: full product specification, UX architecture, and UI system.
- `index.html`, `app.js`, `styles.css`: a functional FORGE MVP UI shell prototype based on the specification.

## Run locally
Because the app is a static client prototype, run any static server from the repo root:

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080/index.html`

## Prototype scope implemented
- Workspace shell with far-left rail, left navigation panel, main content canvas, right context panel, and optional operations dock.
- 16 required major screens as navigable views, each with:
  - layout anatomy
  - component inventory
  - states
  - key interactions
  - permission effects
  - responsive behavior
  - AI affordances
  - audit history placement
- Required object model represented in the context panel.
- Role switcher to demonstrate permission-aware behavior.
