import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

// In the container HOST is 0.0.0.0 and the documented `docker run` publishes the
// port on 127.0.0.1 only. Outside Docker it stays on loopback by default.
const port = Number(process.env.PORT ?? 7878);
const host = process.env.HOST ?? "127.0.0.1";
const here = dirname(fileURLToPath(import.meta.url));
// Compiled to dist/server/src/index.js; the UI build lives in dist/web.
const webRoot = process.env.WEB_ROOT ?? resolve(here, "../../web");
const inContainer = process.env.YAMLET_IN_CONTAINER === "1" || existsSync("/.dockerenv");
const defaultWorkspace = process.env.YAMLET_WORKSPACE ?? (inContainer ? "/workspace" : null);
const browseRoot = resolve(process.env.YAMLET_BROWSE_ROOT ?? (inContainer ? "/workspace" : homedir()));

const app = await buildApp({
  config: {
    version: process.env.APP_VERSION ?? "dev",
    browseRoot,
    defaultWorkspace: defaultWorkspace ? resolve(defaultWorkspace) : null,
    inContainer,
    publicUrl: process.env.YAMLET_PUBLIC_URL ?? `http://localhost:${port}`,
    defaultTimeoutMs: Number(process.env.YAMLET_TIMEOUT_MS ?? 30_000),
    interceptorDataDir: process.env.YAMLET_INTERCEPTOR_DATA_DIR ?? (inContainer ? "/data" : resolve(homedir(), ".config/yamlet")),
    updateCheck: process.env.YAMLET_UPDATE_CHECK !== "0" && (process.env.APP_VERSION ?? "dev") !== "dev",
  },
  webRoot,
  logger: true,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
