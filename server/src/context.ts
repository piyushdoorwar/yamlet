import type { Dispatcher } from "undici";
import { CookieJar } from "../../core/src/cookieJar.js";
import { WorkspaceStore } from "../../core/src/workspaceStore.js";
import { WORKSPACE_HEADER } from "../../shared/api.js";
import { HttpError } from "./errors.js";
import { confine } from "./paths.js";

export interface ServerConfig {
  version: string;
  browseRoot: string;
  defaultWorkspace: string | null;
  inContainer: boolean;
  publicUrl: string;
  /** Injected in tests so no real network is used. */
  dispatcher?: Dispatcher;
  defaultTimeoutMs: number;
  /** Private state outside the workspace YAML files. */
  interceptorDataDir?: string;
  /** Look for newer releases on GitHub (off unless set; index.ts turns it on). */
  updateCheck?: boolean;
}

interface OpenWorkspace {
  store: WorkspaceStore;
  cookies: CookieJar;
}

/** Open workspaces keyed by root path; each has its own cookie jar. */
export class Workspaces {
  private readonly open = new Map<string, OpenWorkspace>();
  private readonly pending = new Map<string, Promise<OpenWorkspace>>();

  constructor(private readonly config: ServerConfig) {}

  async openAt(path: string, create = false): Promise<OpenWorkspace> {
    const dir = confine(this.config.browseRoot, path);
    if (!create && !(await WorkspaceStore.isWorkspace(dir))) {
      throw new HttpError(404, `No Yamlet workspace in ${dir}`);
    }
    const root = WorkspaceStore.resolveRoot(dir);
    const existing = this.open.get(root) ?? this.open.get(dir);
    if (existing && !create) {
      await existing.store.reload();
      return existing;
    }
    const inflight = this.pending.get(root);
    if (inflight) return inflight;
    const loading = (async () => {
      const store = create ? await WorkspaceStore.create(dir) : await WorkspaceStore.open(dir);
      const entry = { store, cookies: existing?.cookies ?? new CookieJar() };
      this.open.set(store.workspace.rootPath, entry);
      return entry;
    })();
    this.pending.set(root, loading);
    try {
      return await loading;
    } finally {
      this.pending.delete(root);
    }
  }

  /** An open workspace by root path without reloading it from disk; opens it if needed. */
  async peek(root: string): Promise<OpenWorkspace> {
    return this.open.get(root) ?? this.openAt(root);
  }

  /** The workspace named by the request's x-yamlet-workspace header, opening it on demand. */
  async fromHeaders(headers: Record<string, string | string[] | undefined>): Promise<OpenWorkspace> {
    const raw = headers[WORKSPACE_HEADER];
    const path = Array.isArray(raw) ? raw[0] : raw;
    if (!path) throw new HttpError(400, `Missing ${WORKSPACE_HEADER} header`);
    const key = decodeURIComponent(path);
    const hit = this.open.get(key);
    if (hit) return hit;
    return this.openAt(key);
  }
}
