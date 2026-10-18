import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Dispatcher } from "undici";
import type { ExecuteInput } from "../../core/src/requestExecutor.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dispatcherFor } from "../../core/src/agents.js";
import { SettingsFile } from "../../core/src/appSettings.js";
import { defaultNetworkSettings, setYamletVersion } from "../../core/src/models.js";
import { type ServerConfig, Workspaces } from "./context.js";
import { toHttpError } from "./errors.js";
import { cookieRoutes } from "./routes/cookies.js";
import { fileRoutes } from "./routes/files.js";
import { importRoutes } from "./routes/import.js";
import { interceptorRoutes } from "./routes/interceptor.js";
import { itemRoutes } from "./routes/items.js";
import { oauthRoutes } from "./routes/oauth.js";
import { runnerRoutes } from "./routes/runner.js";
import { sendRoutes } from "./routes/send.js";
import { systemRoutes } from "./routes/system.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { allowedHostnames, registerSecurity } from "./security.js";

export interface AppOptions {
  config: ServerConfig;
  /** Built UI (dist/web). Omitted in tests and in dev, where Vite serves the UI. */
  webRoot?: string;
  logger?: boolean;
  allowedHosts?: string;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 50 * 1024 * 1024 });

  registerSecurity(app, allowedHostnames(opts.allowedHosts));

  app.setErrorHandler((err, _req, reply) => {
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const { statusCode, message } = toHttpError(err);
    if (statusCode >= 500) app.log.error(err);
    return reply.code(statusCode).send({ error: message });
  });

  await app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

  setYamletVersion(opts.config.version);
  const workspaces = new Workspaces(opts.config);
  const config = opts.config;
  // Env vars give the defaults; the Settings screen overrides them.
  const settings = await SettingsFile.open(config.dataDir, {
    timeoutMs: config.defaultTimeoutMs,
    maxResponseMb: config.maxResponseBytes === undefined ? 50 : config.maxResponseBytes / 1024 / 1024,
    network: defaultNetworkSettings(),
  });
  const deps: Deps = {
    config,
    workspaces,
    settings,
    sendOptions: () => {
      const s = settings.get();
      return { defaultTimeoutMs: s.timeoutMs, maxResponseBytes: s.maxResponseMb * 1024 * 1024, network: s.network, dispatcher: config.dispatcher };
    },
    dispatcher: () => config.dispatcher ?? dispatcherFor(settings.get().network),
  };

  systemRoutes(app, deps);
  workspaceRoutes(app, deps);
  itemRoutes(app, deps);
  sendRoutes(app, deps);
  oauthRoutes(app, deps);
  runnerRoutes(app, deps);
  importRoutes(app, deps);
  cookieRoutes(app, deps);
  interceptorRoutes(app, deps);
  fileRoutes(app, deps);

  app.addHook("onClose", async () => workspaces.flush());

  const webRoot = opts.webRoot && existsSync(join(opts.webRoot, "index.html")) ? opts.webRoot : undefined;
  if (webRoot) await app.register(fastifyStatic, { root: webRoot });

  app.setNotFoundHandler((req, reply) => {
    if (webRoot && req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });

  return app;
}

export type Deps = {
  config: ServerConfig;
  workspaces: Workspaces;
  settings: SettingsFile;
  /** Options every request send takes from the current settings. */
  sendOptions: () => Pick<ExecuteInput, "defaultTimeoutMs" | "maxResponseBytes" | "network" | "dispatcher">;
  /** For Yamlet's own calls (OAuth token endpoints): the same proxy and certificates. */
  dispatcher: () => Dispatcher;
};
