import { defineConfig } from "vite";

export default defineConfig({
  appType: "spa",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: "index.html",
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
