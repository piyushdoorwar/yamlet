import type { FastifyInstance } from "fastify";
import { type Dispatcher, fetch } from "undici";
import { yamletUserAgent } from "../../../core/src/models.js";
import { errMessage } from "../../../core/src/requestExecutor.js";
import { parseCurl } from "../../../core/src/curl.js";
import { bundleExternalRefs, detectImportFormat, importCollectionV2, importEnvironmentJson, importHar, importOpenApi } from "../../../core/src/importers.js";
import type { ImportBody, ImportResult } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";

const MAX_LINK_BYTES = 20 * 1024 * 1024;

/** Fetches an import from a link, with the app's network settings (proxy, certificates). */
async function fetchLink(url: string, dispatcher: Dispatcher | undefined): Promise<{ text: string; fileName: string }> {
  let res: Response;
  try {
    res = (await fetch(url, { headers: { accept: "application/json, application/yaml, text/yaml, */*", "user-agent": yamletUserAgent() }, dispatcher })) as unknown as Response;
  } catch (err) {
    throw new HttpError(502, `Could not fetch ${url}: ${errMessage(err)}`);
  }
  if (!res.ok) throw new HttpError(502, `Fetching ${url} answered ${res.status}.`);
  if (Number(res.headers.get("content-length")) > MAX_LINK_BYTES) throw new HttpError(413, `${url} is larger than 20 MB.`);
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader?.read();
    if (!part || part.done) break;
    size += part.value.length;
    if (size > MAX_LINK_BYTES) {
      await reader?.cancel();
      throw new HttpError(413, `${url} is larger than 20 MB.`);
    }
    chunks.push(part.value);
  }
  const name = decodeURIComponent(new URL(res.url || url).pathname.split("/").pop() || "") || "import";
  return { text: Buffer.concat(chunks).toString("utf8"), fileName: name };
}

export function importRoutes(app: FastifyInstance, { workspaces, dispatcher }: Deps): void {
  app.post<{ Body: ImportBody }>("/api/import", async (req): Promise<ImportResult> => {
    const { store } = await workspaces.fromHeaders(req.headers);
    let text = req.body?.text ?? "";
    if (!text.trim()) throw new HttpError(400, "Nothing to import");
    let format = detectImportFormat(text);
    let link: string | undefined;
    if (format === "link") {
      link = text.trim();
      const fetched = await fetchLink(link, dispatcher());
      text = fetched.text;
      req.body.fileName = fetched.fileName;
      format = detectImportFormat(text);
      if (format === "link") format = "unknown";
    }
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
        case "har": {
          const name = req.body.fileName?.replace(/\.har$/i, "").trim() || "HAR import";
          const c = await store.importCollection(importHar(JSON.parse(text), name));
          return { kind: "collection", workspace: store.workspace, collectionId: c.id };
        }
        case "openapi": {
          // From a link, refs into other files are fetched next to it.
          const source = link ? await bundleExternalRefs(text, link, async (u) => (await fetchLink(u, dispatcher())).text) : text;
          const c = await store.importCollection(importOpenApi(source));
          return { kind: "collection", workspace: store.workspace, collectionId: c.id };
        }
        default:
          throw new HttpError(400, "Unrecognised format. Paste a cURL command, an OpenAPI/Swagger document, a HAR file, or a v2.1 collection or environment JSON export.");
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `Import failed: ${(err as Error).message}`);
    }
  });
}
