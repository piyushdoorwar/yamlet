import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The UI lives in web/ and builds into dist/web, which the server serves.
// In dev, Vite proxies /api to the server on :7878 (or $YAMLET_API_PORT).
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  // The UI reuses the engine's browser-safe modules (variables, snippets, cURL).
  resolve: { alias: { "@core": fileURLToPath(new URL("./core/src", import.meta.url)) } },
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.YAMLET_API_PORT ?? 7878}`, ws: true } },
  },
});
