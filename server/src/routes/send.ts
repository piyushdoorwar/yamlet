import type { FastifyInstance, FastifyReply } from "fastify";
import { inheritLocal, type Variable } from "../../../core/src/models.js";
import { execute } from "../../../core/src/requestExecutor.js";
import type { WorkspaceStore } from "../../../core/src/workspaceStore.js";
import type { SendBody, SendResult } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";

/** An AbortSignal that fires when the browser gives up on the response (Cancel button). */
export function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

export interface ScopeChanges {
  environment?: Variable[];
  collectionVariables?: Variable[];
  globals?: Variable[];
}

/**
 * Write variable changes made by scripts back to their files (local ones to the data folder).
 * Variables a script creates are local when the scope is. Returns true if anything changed.
 */
export async function persistChanges(
  store: WorkspaceStore,
  changes: ScopeChanges,
  environmentId: string | null | undefined,
  collectionId: string | undefined,
): Promise<boolean> {
  // Skip unchanged scopes so files aren't rewritten (and Git stays quiet).
  const same = (a: Variable[], b: Variable[]) => JSON.stringify(a) === JSON.stringify(b);
  let changed = false;
  if (changes.environment && environmentId) {
    const env = store.findEnvironment(environmentId);
    if (env && !same(env.variables, changes.environment)) {
      await store.saveEnvironment({ ...env, variables: inheritLocal(env.variables, changes.environment) });
      changed = true;
    }
  }
  const collection = collectionId ? store.findCollection(collectionId) : undefined;
  if (changes.collectionVariables && collection && !same(collection.variables, changes.collectionVariables)) {
    await store.updateCollection(collection.id, { variables: inheritLocal(collection.variables, changes.collectionVariables) });
    changed = true;
  }
  if (changes.globals && !same(store.workspace.globals, changes.globals)) {
    await store.saveGlobals(inheritLocal(store.workspace.globals, changes.globals));
    changed = true;
  }
  return changed;
}

export function sendRoutes(app: FastifyInstance, { workspaces, config }: Deps): void {
  app.post<{ Body: SendBody }>("/api/send", async (req, reply): Promise<SendResult> => {
    const { store, cookies } = await workspaces.fromHeaders(req.headers);
    const { request, environmentId } = req.body ?? ({} as SendBody);
    if (!request) throw new HttpError(400, "Missing request");
    const collectionId = req.body.collectionId ?? store.findRequest(request.id)?.collection.id;
    const collection = collectionId ? store.findCollection(collectionId) : undefined;
    const environment = environmentId ? store.findEnvironment(environmentId) : undefined;

    const { response, changes } = await execute({
      request,
      collection,
      environment,
      globals: store.workspace.globals,
      workspaceRoot: store.workspace.rootPath,
      cookieJar: cookies,
      defaultTimeoutMs: config.defaultTimeoutMs,
      dispatcher: config.dispatcher,
      signal: abortOnDisconnect(reply),
    });

    const changed = await persistChanges(store, changes, environmentId, collection?.id);
    return changed ? { response, workspace: store.workspace } : { response };
  });
}
