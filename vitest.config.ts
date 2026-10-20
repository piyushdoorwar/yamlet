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
        resolve: {
          alias: {
            "@core": fileURLToPath(new URL("./core/src", import.meta.url)),
            // Its ES module build, as the app bundle uses, so it shares the tests' graphql instance.
            "graphql-language-service": fileURLToPath(new URL("./node_modules/graphql-language-service/esm/index.js", import.meta.url)),
          },
        },
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
