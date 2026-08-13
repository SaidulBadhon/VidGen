import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The SPA is served by the Bun server in production, so the dev server proxies
// the API and task media to it instead of duplicating those routes here.
const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:7778";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 7777,
    strictPort: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/tasks": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
