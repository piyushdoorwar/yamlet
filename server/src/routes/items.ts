import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Variable, YamletEnvironment, YamletRequest } from "../../../core/src/models.js";
import type { CollectionPatch, FolderPatch, MoveBody, MutationResult } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";

type IdParams = { Params: { id: string } };

function requireName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "A name is required");
  return name.trim();
}

/** Collections, folders, requests, environments and globals: thin wrappers over WorkspaceStore. */
export function itemRoutes(app: FastifyInstance, { workspaces }: Deps): void {
  const store = async (req: FastifyRequest) => (await workspaces.fromHeaders(req.headers)).store;
  const result = <T>(s: { workspace: MutationResult<T>["workspace"] }, item: T): MutationResult<T> => ({
    workspace: s.workspace,
    item,
  });

  // --- collections ---
  app.post<{ Body: { name: string } }>("/api/collections", async (req) => {
    const s = await store(req);
    return result(s, await s.createCollection(requireName(req.body?.name)));
  });
  app.patch<IdParams & { Body: CollectionPatch }>("/api/collections/:id", async (req) => {
    const s = await store(req);
    return result(s, await s.updateCollection(req.params.id, req.body ?? {}));
  });
  app.delete<IdParams>("/api/collections/:id", async (req) => {
    const s = await store(req);
    await s.deleteCollection(req.params.id);
    return result(s, { id: req.params.id });
  });
  app.post<IdParams>("/api/collections/:id/duplicate", async (req) => {
    const s = await store(req);
    return result(s, await s.duplicateCollection(req.params.id));
  });

  // --- folders ---
  app.post<{ Body: { collectionId: string; parentFolderId: string | null; name: string } }>("/api/folders", async (req) => {
    const s = await store(req);
    const { collectionId, parentFolderId } = req.body ?? ({} as never);
    return result(s, await s.createFolder(collectionId, parentFolderId ?? null, requireName(req.body?.name)));
  });
  app.patch<IdParams & { Body: FolderPatch }>("/api/folders/:id", async (req) => {
    const s = await store(req);
    return result(s, await s.updateFolder(req.params.id, req.body ?? {}));
  });
  app.delete<IdParams>("/api/folders/:id", async (req) => {
    const s = await store(req);
    await s.deleteFolder(req.params.id);
    return result(s, { id: req.params.id });
  });
  app.post<IdParams>("/api/folders/:id/duplicate", async (req) => {
    const s = await store(req);
    return result(s, await s.duplicateFolder(req.params.id));
  });

  // --- requests ---
  app.post<{ Body: { collectionId: string; parentFolderId: string | null; init?: Partial<YamletRequest> } }>(
    "/api/requests",
    async (req) => {
      const s = await store(req);
      const { collectionId, parentFolderId, init } = req.body ?? ({} as never);
      return result(s, await s.createRequest(collectionId, parentFolderId ?? null, init));
    },
  );
  app.put<IdParams & { Body: { request: YamletRequest } }>("/api/requests/:id", async (req) => {
    const s = await store(req);
    const request = req.body?.request;
    if (!request || request.id !== req.params.id) throw new HttpError(400, "Request id mismatch");
    return result(s, await s.saveRequest(request));
  });
  app.delete<IdParams>("/api/requests/:id", async (req) => {
    const s = await store(req);
    await s.deleteRequest(req.params.id);
    return result(s, { id: req.params.id });
  });
  app.post<IdParams>("/api/requests/:id/duplicate", async (req) => {
    const s = await store(req);
    return result(s, await s.duplicateRequest(req.params.id));
  });

  app.post<{ Body: MoveBody }>("/api/move", async (req) => {
    const s = await store(req);
    const b = req.body;
    if (!b || (b.kind !== "request" && b.kind !== "folder")) throw new HttpError(400, "Invalid move");
    await s.move(b.kind, b.id, b.targetCollectionId, b.targetFolderId ?? null, Math.max(0, b.index | 0));
    return result(s, { id: b.id });
  });

  // --- environments & globals ---
  app.post<{ Body: { name: string; variables?: Variable[] } }>("/api/environments", async (req) => {
    const s = await store(req);
    let env = await s.createEnvironment(requireName(req.body?.name));
    if (req.body.variables?.length) env = await s.saveEnvironment({ ...env, variables: req.body.variables });
    return result(s, env);
  });
  app.put<IdParams & { Body: { environment: YamletEnvironment } }>("/api/environments/:id", async (req) => {
    const s = await store(req);
    const env = req.body?.environment;
    if (!env || env.id !== req.params.id) throw new HttpError(400, "Environment id mismatch");
    return result(s, await s.saveEnvironment(env));
  });
  app.delete<IdParams>("/api/environments/:id", async (req) => {
    const s = await store(req);
    await s.deleteEnvironment(req.params.id);
    return result(s, { id: req.params.id });
  });
  app.post<IdParams>("/api/environments/:id/duplicate", async (req) => {
    const s = await store(req);
    return result(s, await s.duplicateEnvironment(req.params.id));
  });
  app.put<{ Body: { variables: Variable[] } }>("/api/globals", async (req) => {
    const s = await store(req);
    await s.saveGlobals(req.body?.variables ?? []);
    return result(s, s.workspace.globals);
  });
}
