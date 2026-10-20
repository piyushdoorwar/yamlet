import type { FastifyInstance, FastifyReply } from "fastify";
import { asCurrentValues, inheritLocal, type Variable } from "../../../core/src/models.js";
import { execute, isTextualType, textDecoderFor, type ExecuteInput } from "../../../core/src/requestExecutor.js";
import type { WorkspaceStore } from "../../../core/src/workspaceStore.js";
import type { SendBody, SendEvent, SendResult } from "../../../shared/api.js";
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
 * Keep variable changes made by scripts as current values in the data folder; the files keep
 * their initial values. Variables a script creates are local when the scope is. Returns true
 * if anything changed.
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
      await store.saveEnvironment({ ...env, variables: asCurrentValues(env.variables, inheritLocal(env.variables, changes.environment)) });
      changed = true;
    }
  }
  const collection = collectionId ? store.findCollection(collectionId) : undefined;
  if (changes.collectionVariables && collection && !same(collection.variables, changes.collectionVariables)) {
    await store.updateCollection(collection.id, { variables: asCurrentValues(collection.variables, inheritLocal(collection.variables, changes.collectionVariables)) });
    changed = true;
  }
  if (changes.globals && !same(store.workspace.globals, changes.globals)) {
    await store.saveGlobals(asCurrentValues(store.workspace.globals, inheritLocal(store.workspace.globals, changes.globals)));
    changed = true;
  }
  return changed;
}

/** Stores a refreshed OAuth 2.0 token in the collection's auth (the refresh token too, if it rotated). */
export async function saveCollectionToken(store: WorkspaceStore, collectionId: string, t: { accessToken: string; refreshToken?: string; expiresAt?: number }): Promise<void> {
  await store.setToken(collectionId, t);
}

/** Stores a refreshed OAuth 2.0 token in a folder's auth. */
export async function saveFolderToken(store: WorkspaceStore, folderId: string, t: { accessToken: string; refreshToken?: string; expiresAt?: number }): Promise<void> {
  await store.setToken(folderId, t);
}

/** Gap between streamed body pieces; small pieces arriving faster are merged. */
const CHUNK_FLUSH_MS = 50;

export function sendRoutes(app: FastifyInstance, { workspaces, sendOptions }: Deps): void {
  app.post<{ Body: SendBody }>("/api/send", async (req, reply): Promise<SendResult | void> => {
    const { store, cookies } = await workspaces.fromHeaders(req.headers);
    const { request, environmentId } = req.body ?? ({} as SendBody);
    if (!request) throw new HttpError(400, "Missing request");
    const loc = store.findRequest(request.id);
    const collectionId = req.body.collectionId ?? loc?.collection.id;
    const collection = collectionId ? store.findCollection(collectionId) : undefined;
    const environment = environmentId ? store.findEnvironment(environmentId) : undefined;
    const signal = abortOnDisconnect(reply);

    const run = async (stream?: Pick<ExecuteInput, "onHead" | "onChunk">): Promise<SendResult> => {
      const { response, changes, oauthRefreshed } = await execute({
        request,
        collection,
        environment,
        globals: store.workspace.globals,
        workspaceRoot: store.workspace.rootPath,
        cookieJar: cookies,
        folders: loc && loc.collection.id === collection?.id ? loc.folders : undefined,
        ...sendOptions(),
        signal,
        ...stream,
      });
      let changed = false;
      try {
        if (oauthRefreshed?.source === "collection" && collection) {
          await saveCollectionToken(store, collection.id, oauthRefreshed);
          changed = true;
        } else if (oauthRefreshed?.source === "folder" && oauthRefreshed.folderId) {
          await saveFolderToken(store, oauthRefreshed.folderId, oauthRefreshed);
          changed = true;
        }
        changed = (await persistChanges(store, changes, environmentId, collection?.id)) || changed;
      } catch (e) {
        // The response still comes back; saving what the scripts changed is what failed.
        const note = `[warn] Variable changes from scripts weren't saved: ${e instanceof Error ? e.message : String(e)}`;
        response.scriptLogs.push(note);
        response.consoleText = `${response.consoleText}${response.consoleText ? "\n" : ""}${note}`;
      }
      const token = oauthRefreshed?.source === "request" ? { oauthRefreshed: { accessToken: oauthRefreshed.accessToken, refreshToken: oauthRefreshed.refreshToken, expiresAt: oauthRefreshed.expiresAt } } : {};
      return changed ? { response, workspace: store.workspace, ...token } : { response, ...token };
    };
    if (!req.body.stream) return run();

    // NDJSON: the head, body pieces as they arrive, then the full result.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    const emit = (e: SendEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
    };
    let decoder: TextDecoder | undefined;
    let pending = "";
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      emit({ type: "chunk", bytes, ...(decoder ? { text: pending } : {}) });
      pending = "";
    };
    try {
      const result = await run({
        onHead: (head) => {
          // A retried request starts over.
          if (timer) clearTimeout(timer);
          timer = undefined;
          pending = "";
          bytes = 0;
          // Untyped bodies are shown as text while they arrive; the final result decides.
          decoder = isTextualType(head.contentType) === false ? undefined : textDecoderFor(head.contentType);
          emit({ type: "head", ...head });
        },
        onChunk: (chunk) => {
          bytes += chunk.byteLength;
          if (decoder) pending += decoder.decode(chunk, { stream: true });
          timer ??= setTimeout(flush, CHUNK_FLUSH_MS);
        },
      });
      if (timer) flush();
      // The browser already has a text body from the pieces; don't send it twice.
      const streamed = !!decoder && !result.response.isError && result.response.bodyEncoding === "utf8" && bytes > 0;
      emit(streamed ? { type: "done", result: { ...result, response: { ...result.response, body: "" } }, bodyStreamed: true } : { type: "done", result });
    } catch (err) {
      emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (timer) clearTimeout(timer);
      res.end();
    }
  });
}
