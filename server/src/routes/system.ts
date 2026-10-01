import type { FastifyInstance } from "fastify";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceStore } from "../../../core/src/workspaceStore.js";
import type { FsEntry, FsListing, ServerInfo } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";
import { confine, isInside } from "../paths.js";

export function systemRoutes(app: FastifyInstance, { config }: Deps): void {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/info", async (): Promise<ServerInfo> => ({
    version: config.version,
    defaultWorkspace: config.defaultWorkspace,
    browseRoot: config.browseRoot,
    inContainer: config.inContainer,
    oauthCallbackUrl: `${config.publicUrl}/api/oauth2/callback`,
  }));

  // Folder browser for "Open workspace" and file pickers, confined to browseRoot.
  app.get<{ Querystring: { path?: string; files?: string } }>("/api/fs/list", async (req): Promise<FsListing> => {
    const dir = confine(config.browseRoot, req.query.path || config.browseRoot);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) throw new HttpError(404, `Not a folder: ${dir}`);
    const withFiles = req.query.files === "1";
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      const path = join(dir, d.name);
      if (d.isDirectory()) {
        entries.push({ name: d.name, path, kind: "dir", isWorkspace: await WorkspaceStore.isWorkspace(path) });
      } else if (withFiles && d.isFile()) {
        entries.push({ name: d.name, path, kind: "file" });
      }
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    const parent = dir !== config.browseRoot && isInside(config.browseRoot, dirname(dir)) ? dirname(dir) : null;
    return { path: dir, parent, isWorkspace: await WorkspaceStore.isWorkspace(dir), entries };
  });
}
