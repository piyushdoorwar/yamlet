import type { Variable, YamletCollection, YamletEnvironment, YamletFolder, YamletRequest } from "@core/models";
import {
  type AuthorizeResult,
  type AuthorizeStatus,
  type CollectionPatch,
  type CookieInfo,
  CSRF_HEADER,
  type FolderPatch,
  type FsListing,
  type ImportResult,
  type MoveBody,
  type MutationResult,
  type RunBody,
  type RunEvent,
  type SendBody,
  type SendResult,
  type ServerInfo,
  type TokenBody,
  type TokenResult,
  type UploadResult,
  WORKSPACE_HEADER,
  type WorkspaceResult,
} from "../../../shared/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let currentWorkspace: string | null = null;

/** Every workspace-scoped call targets this root path. */
export function setApiWorkspace(root: string | null): void {
  currentWorkspace = root;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function headersFor(method: Method, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers[CSRF_HEADER] = "1";
  if (json) headers["content-type"] = "application/json";
  if (currentWorkspace) headers[WORKSPACE_HEADER] = encodeURIComponent(currentWorkspace);
  return headers;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: headersFor(method, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return parse<T>(res);
}

const enc = encodeURIComponent;

export const api = {
  info: () => request<ServerInfo>("GET", "/api/info"),
  listDir: (path?: string, files = false) =>
    request<FsListing>("GET", `/api/fs/list?${new URLSearchParams({ ...(path ? { path } : {}), ...(files ? { files: "1" } : {}) })}`),

  openWorkspace: (path: string) => request<WorkspaceResult>("POST", "/api/workspace/open", { path }),
  createWorkspace: (path: string) => request<WorkspaceResult>("POST", "/api/workspace/create", { path }),
  reloadWorkspace: () => request<WorkspaceResult>("POST", "/api/workspace/reload"),

  createCollection: (name: string) => request<MutationResult<YamletCollection>>("POST", "/api/collections", { name }),
  updateCollection: (id: string, patch: CollectionPatch) =>
    request<MutationResult<YamletCollection>>("PATCH", `/api/collections/${enc(id)}`, patch),
  deleteCollection: (id: string) => request<MutationResult<{ id: string }>>("DELETE", `/api/collections/${enc(id)}`),
  duplicateCollection: (id: string) => request<MutationResult<YamletCollection>>("POST", `/api/collections/${enc(id)}/duplicate`),

  createFolder: (collectionId: string, parentFolderId: string | null, name: string) =>
    request<MutationResult<YamletFolder>>("POST", "/api/folders", { collectionId, parentFolderId, name }),
  updateFolder: (id: string, patch: FolderPatch) => request<MutationResult<YamletFolder>>("PATCH", `/api/folders/${enc(id)}`, patch),
  deleteFolder: (id: string) => request<MutationResult<{ id: string }>>("DELETE", `/api/folders/${enc(id)}`),
  duplicateFolder: (id: string) => request<MutationResult<YamletFolder>>("POST", `/api/folders/${enc(id)}/duplicate`),

  createRequest: (collectionId: string, parentFolderId: string | null, init?: Partial<YamletRequest>) =>
    request<MutationResult<YamletRequest>>("POST", "/api/requests", { collectionId, parentFolderId, init }),
  saveRequest: (req: YamletRequest) => request<MutationResult<YamletRequest>>("PUT", `/api/requests/${enc(req.id)}`, { request: req }),
  deleteRequest: (id: string) => request<MutationResult<{ id: string }>>("DELETE", `/api/requests/${enc(id)}`),
  duplicateRequest: (id: string) => request<MutationResult<YamletRequest>>("POST", `/api/requests/${enc(id)}/duplicate`),
  move: (body: MoveBody) => request<MutationResult<{ id: string }>>("POST", "/api/move", body),

  createEnvironment: (name: string, variables?: Variable[]) =>
    request<MutationResult<YamletEnvironment>>("POST", "/api/environments", { name, variables }),
  saveEnvironment: (env: YamletEnvironment) =>
    request<MutationResult<YamletEnvironment>>("PUT", `/api/environments/${enc(env.id)}`, { environment: env }),
  deleteEnvironment: (id: string) => request<MutationResult<{ id: string }>>("DELETE", `/api/environments/${enc(id)}`),
  duplicateEnvironment: (id: string) => request<MutationResult<YamletEnvironment>>("POST", `/api/environments/${enc(id)}/duplicate`),
  saveGlobals: (variables: Variable[]) => request<MutationResult<Variable[]>>("PUT", "/api/globals", { variables }),

  send: (body: SendBody, signal?: AbortSignal) => request<SendResult>("POST", "/api/send", body, signal),

  fetchToken: (body: TokenBody) => request<TokenResult>("POST", "/api/oauth2/token", body),
  authorize: (body: TokenBody) => request<AuthorizeResult>("POST", "/api/oauth2/authorize", body),
  authorizeStatus: (state: string) => request<AuthorizeStatus>("GET", `/api/oauth2/authorize/status?state=${enc(state)}`),

  importText: (text: string, fileName?: string) => request<ImportResult>("POST", "/api/import", { text, fileName }),

  cookies: () => request<CookieInfo[]>("GET", "/api/cookies"),
  deleteCookie: (domain: string, name: string, path?: string) =>
    request<{ ok: true }>("DELETE", `/api/cookies?${new URLSearchParams({ domain, name, ...(path ? { path } : {}) })}`),
  clearCookies: (domain?: string) => request<{ ok: true }>("DELETE", `/api/cookies${domain ? `?domain=${enc(domain)}` : ""}`),

  upload: async (file: File): Promise<UploadResult> => {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch("/api/files", { method: "POST", headers: headersFor("POST", false), body: form });
    return parse<UploadResult>(res);
  },

  /** Stream runner events (NDJSON) as they arrive. */
  run: async (body: RunBody, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<void> => {
    const res = await fetch("/api/runner/run", {
      method: "POST",
      headers: headersFor("POST", true),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      await parse(res);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onEvent(JSON.parse(line) as RunEvent);
      }
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer) as RunEvent);
  },
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
