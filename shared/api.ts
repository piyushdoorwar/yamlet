// JSON shapes exchanged between the browser and the Yamlet server.
import type {
  OAuth2Config,
  ScriptTestResult,
  Variable,
  YamletCollection,
  YamletEnvironment,
  YamletFolder,
  YamletRequest,
  YamletResponse,
  YamletWorkspace,
} from "../core/src/models.js";

/** Every non-GET request must carry this header (CSRF guard). */
export const CSRF_HEADER = "x-yamlet";
/** Which open workspace (its root path) a request targets. */
export const WORKSPACE_HEADER = "x-yamlet-workspace";

export interface ServerInfo {
  version: string;
  /** Workspace opened on first visit (the container's mounted folder). */
  defaultWorkspace: string | null;
  /** The folder browser is confined to this directory. */
  browseRoot: string;
  inContainer: boolean;
  /** The OAuth 2.0 authorization-code redirect URI this server listens on. */
  oauthCallbackUrl: string;
}

/** Result of the hourly check for a newer Yamlet release. */
export interface UpdateInfo {
  /** False for dev builds or with YAMLET_UPDATE_CHECK=0. */
  enabled: boolean;
  current: string;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  publishedAt?: string;
  checkedAt?: string;
  /** Why the last check failed (the previous result is kept). */
  error?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  /** dir only: already a Yamlet workspace (or contains one). */
  isWorkspace?: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  isWorkspace: boolean;
  entries: FsEntry[];
}

export interface WorkspaceResult {
  workspace: YamletWorkspace;
}

export interface MutationResult<T> {
  workspace: YamletWorkspace;
  item: T;
}

export type CollectionPatch = Partial<
  Pick<YamletCollection, "name" | "description" | "variables" | "auth" | "preRequestScript" | "postResponseScript">
>;
export type FolderPatch = Partial<Pick<YamletFolder, "name" | "description">>;

export interface MoveBody {
  kind: "request" | "folder";
  id: string;
  targetCollectionId: string;
  targetFolderId: string | null;
  index: number;
}

export interface SendBody {
  /** The request as currently edited (may have unsaved changes). */
  request: YamletRequest;
  collectionId?: string;
  environmentId?: string | null;
}

export interface SendResult {
  response: YamletResponse;
  /** Present when scripts changed environment / collection / global variables. */
  workspace?: YamletWorkspace;
}

export interface TokenBody {
  config: OAuth2Config;
  collectionId?: string;
  environmentId?: string | null;
  /** Extra variables visible while resolving (e.g. the request's own). */
  requestVariables?: Variable[];
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
}

export interface AuthorizeResult {
  authUrl: string;
  state: string;
}

export type AuthorizeStatus =
  | { status: "pending" }
  | { status: "done"; token: TokenResult }
  | { status: "error"; error: string };

export interface RunBody {
  collectionId: string;
  folderId?: string;
  requestIds?: string[];
  environmentId?: string | null;
  iterations?: number;
  delayMs?: number;
  bail?: boolean;
  /** Raw CSV or JSON data-file text; one row per iteration. */
  dataText?: string;
  dataFileName?: string;
  /** Persist variable changes made by scripts at the end of the run. */
  persistVariables?: boolean;
}

/** One NDJSON line of a runner stream. */
export type RunEvent =
  | {
      type: "result";
      iteration: number;
      requestId: string;
      name: string;
      path: string[];
      method: string;
      url: string;
      status: number;
      durationMs: number;
      tests: ScriptTestResult[];
      passed: boolean;
      error?: string;
    }
  | { type: "summary"; total: number; passed: number; failed: number; durationMs: number; iterations: number }
  | { type: "error"; error: string };

export interface ImportBody {
  text: string;
  fileName?: string;
}

export type ImportResult =
  | { kind: "collection"; workspace: YamletWorkspace; collectionId: string }
  | { kind: "environment"; workspace: YamletWorkspace; environmentId: string }
  | { kind: "request"; request: YamletRequest };

export interface CookieInfo {
  domain: string;
  path: string;
  name: string;
  value: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
  /** Set when the cookie was synced from Chrome by the Yamlet Interceptor extension. */
  fromBrowser?: boolean;
}

export interface UploadResult {
  /** Path relative to the workspace root, usable in form-data / binary bodies. */
  path: string;
}

export type { YamletEnvironment };
