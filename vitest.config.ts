import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["core/test/**/*.test.ts", "server/test/**/*.test.ts", "cli/test/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { "@core": fileURLToPath(new URL("./core/src", import.meta.url)) } },
        test: {
          name: "web",
          environment: "jsdom",
          globals: true,
          include: ["web/test/**/*.test.{ts,tsx}"],
          setupFiles: ["web/test/setup.ts"],
          css: false,
        },
      },
    ],
  },
});
