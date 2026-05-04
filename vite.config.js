import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

// Vite plugin: strip the esm.sh import map from index.html in production
// builds. The map is only used by `python3 -m http.server` source-mode
// dev where Vite isn't bundling; once Vite has resolved every bare
// specifier into a hashed local chunk, the map is dead weight that also
// forces us to permit `https://esm.sh` in the production CSP.
function stripDevImportMap() {
  return {
    name: "forge:strip-dev-importmap",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(/<!--\s*Import map[\s\S]*?-->/g, "")
        .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/g, "");
    },
  };
}

// Vite plugin: copy a small set of root-level static files into dist on
// build. We don't use Vite's default `public/` directory because dev mode
// (FORGE_SERVE_SOURCE=1) serves the repo root directly, and moving these
// files into `public/` would break that path. So the source-of-truth lives
// at the repo root and we copy on build.
function copyRootStatics() {
  const FILES = ["icon.svg", "manifest.webmanifest", "sample.pdf"];
  return {
    name: "forge:copy-root-statics",
    apply: "build",
    closeBundle() {
      for (const name of FILES) {
        const src = path.resolve(name);
        const dest = path.resolve("dist", name);
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        }
      }
    },
  };
}

// FORGE — Vite production build configuration.
//
// Performance strategy:
// 1. Top-level screens are lazy-loaded from `app.js` so the initial bundle
//    is small. Only the shell + a handful of light landing screens are
//    eagerly imported.
// 2. The heaviest dependencies (WebAssembly + WebGL viewers) get their
//    own deterministic chunk names so the browser can cache them across
//    deployments and the CDN can ship them with `immutable` headers.
// 3. The chunk-size warning threshold is bumped because the WebAssembly
//    payloads are large by nature; performance is governed by what the
//    *initial paint* needs, not by these on-demand chunks.

export default defineConfig({
  appType: "spa",
  plugins: [stripDevImportMap(), copyRootStatics()],
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: "index.html",
      output: {
        // Stable, descriptive chunk names so the asset filename communicates
        // intent in the network panel and so the immutable cache key in the
        // server's static handler stays meaningful.
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // Heavy viewers — keep each on its own chunk so visiting one
          // does not pull in the others.
          if (id.includes("web-ifc"))           return "vendor-web-ifc";
          if (id.includes("online-3d-viewer"))  return "vendor-o3dv";
          if (id.includes("/three/"))           return "vendor-three";
          if (id.includes("/pdfjs-dist/"))      return "vendor-pdfjs";
          if (id.includes("/mermaid/"))         return "vendor-mermaid";
          if (id.includes("dxf-viewer"))        return "vendor-dxf";
          if (id.includes("rapidoc"))           return "vendor-rapidoc";
          if (id.includes("/cytoscape"))        return "vendor-cytoscape";
          // Office document viewers — only loaded when a user opens a
          // Word or Excel file. Each gets its own chunk so visiting one
          // doesn't pull in the other.
          if (id.includes("docx-preview"))      return "vendor-docx";
          if (id.includes("xlsx") || id.includes("/sheetjs/")) return "vendor-xlsx";
          // Univer editor — only loaded when /edit/:docId is hit.
          // ~2 MB gz; kept on its own chunk so the doc viewer never
          // pulls it in.
          if (id.includes("@univerjs/"))        return "vendor-univer";
          // mlightcad browser-side DWG — multi-MB WASM blob; only
          // loaded when a user opens a .dwg file and the browser
          // path is preferred over server-convert.
          if (id.includes("@mlightcad/"))       return "vendor-mlightcad";
          if (id.includes("/mqtt/"))            return "vendor-mqtt";
          if (id.includes("/katex/"))           return "vendor-katex";

          // Search / indexing — small but reused by /search and /docs.
          if (id.includes("minisearch") || id.includes("fuse.js")) return "vendor-search";

          // Markdown + sanitiser used by docs/messages/AI screens.
          if (id.includes("/marked/") || id.includes("dompurify")) return "vendor-md";

          // Telemetry + sparkline charts.
          if (id.includes("/uplot/")) return "vendor-charts";

          // GraphQL / xstate / dexie / papaparse / date-fns: small enough
          // to bundle together in a "vendor-misc" chunk to avoid request
          // amplification on slow networks.
          return "vendor-misc";
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:3000",
      "/v1": "http://localhost:3000",
      "/graphql": "http://localhost:3000",
      "/metrics": "http://localhost:3000",
    },
  },
});
