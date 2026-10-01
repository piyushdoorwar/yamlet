import type { FastifyInstance } from "fastify";
import { parseDataFile, runCollection } from "../../../core/src/collectionRunner.js";
import type { RunBody, RunEvent } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";
import { abortOnDisconnect, persistChanges } from "./send.js";

// Streams one NDJSON line per finished request, then a summary line, so the
// runner tab fills in live.
export function runnerRoutes(app: FastifyInstance, { workspaces, config }: Deps): void {
  app.post<{ Body: RunBody }>("/api/runner/run", async (req, reply) => {
    const { store, cookies } = await workspaces.fromHeaders(req.headers);
    const body = req.body ?? ({} as RunBody);
    const collection = store.findCollection(body.collectionId);
    if (!collection) throw new HttpError(404, "Collection not found");
    const environment = body.environmentId ? store.findEnvironment(body.environmentId) : undefined;
    let data: Record<string, string>[] | undefined;
    if (body.dataText?.trim()) {
      try {
        data = parseDataFile(body.dataText, body.dataFileName ?? "data.csv");
      } catch (err) {
        throw new HttpError(400, `Could not read the data file: ${(err as Error).message}`);
      }
    }

    const signal = abortOnDisconnect(reply);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    const emit = (e: RunEvent) => res.write(`${JSON.stringify(e)}\n`);

    try {
      const summary = await runCollection({
        workspace: store.workspace,
        workspaceRoot: store.workspace.rootPath,
        collectionIds: [collection.id],
        folderId: body.folderId,
        requestIds: body.requestIds,
        environment,
        globals: store.workspace.globals,
        iterations: Math.min(Math.max(body.iterations ?? 1, 1), 1000),
        data,
        delayMs: Math.min(Math.max(body.delayMs ?? 0, 0), 60_000),
        bail: body.bail,
        cookieJar: cookies,
        dispatcher: config.dispatcher,
        signal,
        onResult: (r) => emit({ type: "result", ...r }),
      });
      // Keep variable changes made by scripts, as a single send would.
      if (body.persistVariables !== false) {
        await persistChanges(
          store,
          {
            environment: environment ? summary.variables.environment : undefined,
            collectionVariables: summary.variables.collections[collection.id],
            globals: summary.variables.globals,
          },
          body.environmentId,
          collection.id,
        );
      }
      emit({
        type: "summary",
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        durationMs: summary.durationMs,
        iterations: summary.iterations,
      });
    } catch (err) {
      emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  });
}
