import type { FastifyInstance } from "fastify";
import { parseCurl } from "../../../core/src/curl.js";
import { detectImportFormat, importCollectionV2, importEnvironmentJson, importOpenApi } from "../../../core/src/importers.js";
import type { ImportBody, ImportResult } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";

export function importRoutes(app: FastifyInstance, { workspaces }: Deps): void {
  app.post<{ Body: ImportBody }>("/api/import", async (req): Promise<ImportResult> => {
    const { store } = await workspaces.fromHeaders(req.headers);
    const text = req.body?.text ?? "";
    if (!text.trim()) throw new HttpError(400, "Nothing to import");
    const format = detectImportFormat(text);
    try {
      switch (format) {
        case "curl":
          return { kind: "request", request: parseCurl(text) };
        case "environment": {
          const created = await store.importEnvironment(importEnvironmentJson(JSON.parse(text)));
          return { kind: "environment", workspace: store.workspace, environmentId: created.id };
        }
        case "collection-v2": {
          const c = await store.importCollection(importCollectionV2(JSON.parse(text)));
          return { kind: "collection", workspace: store.workspace, collectionId: c.id };
        }
        case "openapi": {
          const c = await store.importCollection(importOpenApi(text));
          return { kind: "collection", workspace: store.workspace, collectionId: c.id };
        }
        default:
          throw new HttpError(400, "Unrecognised format. Paste a cURL command, an OpenAPI/Swagger document, or a v2.1 collection or environment JSON export.");
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `Import failed: ${(err as Error).message}`);
    }
  });
}
