// Yamlet domain model. Plain data, no I/O: the UI, the server and the CLI all
// speak these shapes. The on-disk YAML is described separately (yamlDtos.ts) and
// mapped to and from these types, so the file format never leaks into the UI.

export interface KeyValue {
  key: string;
  value: string;
  description?: string;
  enabled: boolean;
}

/** A `:name` segment in the URL path, e.g. `/users/:id`. */
export interface PathVariable {
  key: string;
  value: string;
  description?: string;
}

export interface Variable {
  key: string;
  value: string;
  enabled: boolean;
  /** Masked in the UI (secrets). Persisted as `type: secret`. */
  secret?: boolean;
  /**
   * The value is kept in Yamlet's data folder on this machine, never in the YAML file
   * (which keeps the key with a blank value). Persisted as `local: true`.
   */
  local?: boolean;
}

export type AuthType = "inherit" | "none" | "bearer" | "basic" | "apikey" | "cookie" | "oauth2";
export type ApiKeyLocation = "header" | "query";
export type OAuth2GrantType = "client_credentials" | "authorization_code" | "password";
export type OAuth2TokenLocation = "header" | "query";
export type OAuth2ClientAuthentication = "basic" | "body";

export interface OAuth2Config {
  grantType: OAuth2GrantType;
  accessToken: string;
  refreshToken: string;
  /** Scheme used in the Authorization header (usually "Bearer"). */
  headerPrefix: string;
  accessTokenUrl: string;
  authUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
  username: string;
  password: string;
  addTokenTo: OAuth2TokenLocation;
  clientAuthentication: OAuth2ClientAuthentication;
  /** PKCE challenge method for the authorization-code grant: "S256" or "plain". */
  challengeAlgorithm: "S256" | "plain";
}

/**
 * Auth settings for a request or collection. Only the fields for `type` are used
 * when sending; the rest are kept so switching types doesn't lose input.
 */
export interface Auth {
  type: AuthType;
  token: string;
  username: string;
  password: string;
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyIn: ApiKeyLocation;
  cookie: string;
  oauth2: OAuth2Config;
}

export type BodyType = "none" | "raw" | "json" | "xml" | "text" | "html" | "form-data" | "urlencoded" | "graphql" | "binary";

export interface BodyField {
  key: string;
  value: string;
  description?: string;
  enabled: boolean;
  /** form-data only: `value` is a file path (relative to the workspace, or absolute). */
  isFile?: boolean;
}

export interface RequestBody {
  type: BodyType;
  /** Text payload for raw / json / xml / text / html. */
  raw: string;
  /** Fields for form-data and urlencoded. */
  fields: BodyField[];
  /** GraphQL query document. */
  graphqlQuery: string;
  /** GraphQL variables as JSON text. */
  graphqlVariables: string;
  /** binary: file path (relative to the workspace, or absolute). */
  binaryFile: string;
}

export interface RequestSettings {
  /** Per-request timeout in ms; 0 means the app default. */
  timeoutMs: number;
  followRedirects: boolean;
  skipSslVerification: boolean;
}

/** A saved response shown under a request ("example"). */
export interface ResponseExample {
  id: string;
  name: string;
  status: number;
  headers: KeyValue[];
  body: string;
  contentType?: string;
  savedAt?: string;
}

export interface YamletRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: KeyValue[];
  queryParams: KeyValue[];
  pathVariables: PathVariable[];
  body: RequestBody;
  auth: Auth;
  variables: Variable[];
  description: string;
  preRequestScript: string;
  postResponseScript: string;
  settings: RequestSettings;
  examples: ResponseExample[];
  order: number;
  /** Absolute path of the backing YAML file (server-side). */
  sourceFilePath?: string;
}

export interface YamletFolder {
  id: string;
  name: string;
  description?: string;
  folders: YamletFolder[];
  requests: YamletRequest[];
  order: number;
  directoryPath?: string;
}

export interface YamletCollection {
  id: string;
  name: string;
  description?: string;
  folders: YamletFolder[];
  requests: YamletRequest[];
  variables: Variable[];
  auth: Auth;
  preRequestScript: string;
  postResponseScript: string;
  order: number;
  directoryPath?: string;
  filePath?: string;
}

export interface YamletEnvironment {
  id: string;
  name: string;
  variables: Variable[];
  filePath?: string;
}

export interface YamletWorkspace {
  name: string;
  /** Directory holding collections/, environments/, globals/. */
  rootPath: string;
  collectionsPath: string;
  environmentsPath: string;
  globalsPath: string;
  collections: YamletCollection[];
  environments: YamletEnvironment[];
  globals: Variable[];
}

export interface ScriptTestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ResponseCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface ResponseTimings {
  /** Total wall time of the HTTP exchange in ms. */
  total: number;
  /** Time until response headers arrived. */
  firstByte?: number;
  /** Time spent reading the body. */
  download?: number;
}

export interface YamletResponse {
  statusCode: number;
  reasonPhrase: string;
  durationMs: number;
  sizeBytes: number;
  /** URL actually sent: variables expanded, params applied, scripts applied. */
  resolvedUrl: string;
  method: string;
  /** Headers actually sent, for the console / Raw view. */
  requestHeaders: KeyValue[];
  requestBody?: string;
  headers: KeyValue[];
  cookies: ResponseCookie[];
  /** Text body; for binary content this is base64 and `bodyEncoding` is "base64". */
  body: string;
  bodyEncoding: "utf8" | "base64";
  contentType: string;
  timings: ResponseTimings;
  /** Redirects followed before the final response, in order: the status and the URL that sent it. */
  redirects?: { statusCode: number; url: string }[];
  testResults: ScriptTestResult[];
  /** console.log output from pre/post scripts. */
  scriptLogs: string[];
  /** Readable snapshot of the exchange (request line, headers, body). */
  consoleText: string;
  isError: boolean;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Factories. Every shape has a full default so callers never null-check fields.

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function defaultOAuth2(): OAuth2Config {
  return {
    grantType: "client_credentials",
    accessToken: "",
    refreshToken: "",
    headerPrefix: "Bearer",
    accessTokenUrl: "",
    authUrl: "",
    clientId: "",
    clientSecret: "",
    scope: "",
    redirectUri: "",
    username: "",
    password: "",
    addTokenTo: "header",
    clientAuthentication: "basic",
    challengeAlgorithm: "S256",
  };
}

export function defaultAuth(type: AuthType = "inherit"): Auth {
  return {
    type,
    token: "",
    username: "",
    password: "",
    apiKeyName: "",
    apiKeyValue: "",
    apiKeyIn: "header",
    cookie: "",
    oauth2: defaultOAuth2(),
  };
}

export function defaultBody(): RequestBody {
  return { type: "none", raw: "", fields: [], graphqlQuery: "", graphqlVariables: "", binaryFile: "" };
}

export function defaultSettings(): RequestSettings {
  return { timeoutMs: 0, followRedirects: true, skipSslVerification: false };
}

export function newRequest(partial: Partial<YamletRequest> = {}): YamletRequest {
  return {
    id: newId(),
    name: "New Request",
    method: "GET",
    url: "",
    headers: [],
    queryParams: [],
    pathVariables: [],
    body: defaultBody(),
    auth: defaultAuth("inherit"),
    variables: [],
    description: "",
    preRequestScript: "",
    postResponseScript: "",
    settings: defaultSettings(),
    examples: [],
    order: 0,
    ...partial,
  };
}

export function newFolder(partial: Partial<YamletFolder> = {}): YamletFolder {
  return { id: newId(), name: "New Folder", folders: [], requests: [], order: 0, ...partial };
}

export function newCollection(partial: Partial<YamletCollection> = {}): YamletCollection {
  return {
    id: newId(),
    name: "New Collection",
    folders: [],
    requests: [],
    variables: [],
    auth: defaultAuth("none"),
    preRequestScript: "",
    postResponseScript: "",
    order: 0,
    ...partial,
  };
}

export function newEnvironment(partial: Partial<YamletEnvironment> = {}): YamletEnvironment {
  return { id: newId(), name: "New Environment", variables: [], ...partial };
}

/** New variables in a scope are local when every existing one is (the scope's "Local" mode). */
export function scopeIsLocal(vars: readonly Variable[]): boolean {
  return vars.length > 0 && vars.every((v) => v.local);
}

/** Marks variables that `next` adds (by key) as local when `previous` was entirely local. */
export function inheritLocal(previous: readonly Variable[], next: Variable[]): Variable[] {
  if (!scopeIsLocal(previous)) return next;
  const known = new Set(previous.map((v) => v.key));
  return next.map((v) => (known.has(v.key) || v.local !== undefined ? v : { ...v, local: true }));
}

/** QUERY is the safe, idempotent method that carries a body (like GET with a search payload). */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "QUERY", "HEAD", "OPTIONS"] as const;

let yamletVersion = "dev";

/** Sets the version in the User-Agent; the server, CLI and UI call this at startup. */
export function setYamletVersion(version: string): void {
  yamletVersion = version.trim().replace(/^v(?=\d)/, "") || "dev";
}

/** The User-Agent every request carries, e.g. `Yamlet/1.2.0`; shown as a locked header row in the UI. */
export function yamletUserAgent(): string {
  return `Yamlet/${yamletVersion}`;
}
