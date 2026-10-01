import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import type { UploadResult } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";

/** Pick `name`, or `name-2.ext`, `name-3.ext`… if it already exists. */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = basename(name, ext) || "file";
  for (let i = 1; ; i++) {
    const candidate = join(dir, i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`);
    if (!(await stat(candidate).catch(() => null))) return candidate;
  }
}

// Files attached to form-data / binary bodies are copied into the workspace's
// files/ folder, so a request references a path that travels with the repo.
export function fileRoutes(app: FastifyInstance, { workspaces }: Deps): void {
  app.post("/api/files", async (req): Promise<UploadResult> => {
    const { store } = await workspaces.fromHeaders(req.headers);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No file uploaded");
    const safeName = basename(file.filename).replace(/[^\w.\- ]+/g, "_") || "file";
    const dir = join(store.workspace.rootPath, "files");
    await mkdir(dir, { recursive: true });
    const target = await uniquePath(dir, safeName);
    await pipeline(file.file, createWriteStream(target));
    if (file.file.truncated) throw new HttpError(413, "File is too large");
    return { path: relative(store.workspace.rootPath, target).split("\\").join("/") };
  });
}
