import type { FastifyInstance } from "fastify";
import type { WorkspaceResult } from "../../../shared/api.js";
import type { Deps } from "../app.js";

const pathBody = {
  type: "object",
  required: ["path"],
  properties: { path: { type: "string", minLength: 1 } },
} as const;

export function workspaceRoutes(app: FastifyInstance, { workspaces }: Deps): void {
  app.post<{ Body: { path: string } }>("/api/workspace/open", { schema: { body: pathBody } }, async (req): Promise<WorkspaceResult> => {
    const { store } = await workspaces.openAt(req.body.path);
    return { workspace: store.workspace };
  });

  app.post<{ Body: { path: string } }>("/api/workspace/create", { schema: { body: pathBody } }, async (req): Promise<WorkspaceResult> => {
    const { store } = await workspaces.openAt(req.body.path, true);
    return { workspace: store.workspace };
  });

  app.post("/api/workspace/reload", async (req): Promise<WorkspaceResult> => {
    const { store } = await workspaces.fromHeaders(req.headers);
    await store.reload();
    return { workspace: store.workspace };
  });
}
