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
  /**
   * Set when this machine overrides the file's value: the file (shared through Git) keeps
   * `initialValue` and `value` is the current value, kept in Yamlet's data folder. Scripts
   * write current values, so a token a script stores never reaches the file.
   */
  initialValue?: string;
}

export type AuthType = "inherit" | "none" | "bearer" | "basic" | "digest" | "apikey" | "cookie" | "oauth2" | "awsv4";

/** AWS Signature Version 4 credentials and scope. */
export interface AwsSigV4Config {
  accessKey: string;
  secretKey: string;
  /** For temporary credentials; sent as X-Amz-Security-Token. */
  sessionToken: string;
  region: string;
  service: string;
}
export type ApiKeyLocation = "header" | "query";
export type OAuth2GrantType = "client_credentials" | "authorization_code" | "implicit" | "password";
export type OAuth2TokenLocation = "header" | "query";
export type OAuth2ClientAuthentication = "basic" | "body";

export interface OAuth2Config {
  grantType: OAuth2GrantType;
  accessToken: string;
  refreshToken: string;
  /**
   * When the access token expires (ms since the epoch), if the provider said; a token past
   * it is refreshed before sending. Tokens and expiry stay on this machine, never in the YAML.
   */
  expiresAt?: number;
  /** Scheme used in the Authorization header (usually "Bearer"). */
  headerPrefix: string;
  accessTokenUrl: string;
  /** Where refresh requests go, for providers that use another endpoint; blank means the token URL. */
  refreshTokenUrl?: string;
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
  /** Optional `audience` / `resource` parameters some providers need on token and sign-in requests. */
  audience: string;
  resource: string;
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
  /** A scheme read from the file that Yamlet can't send (e.g. "oauth1", "ntlm"); `type` is then "none". */
  unsupported?: string;
  oauth2: OAuth2Config;
  aws: AwsSigV4Config;
}

export type BodyType = "none" | "raw" | "json" | "xml" | "text" | "html" | "javascript" | "form-data" | "urlencoded" | "graphql" | "binary";

export interface BodyField {
  key: string;
  value: string;
  description?: string;
  enabled: boolean;
  /** form-data only: `value` is a file path (relative to the workspace, or absolute). */
  isFile?: boolean;
  /** form-data only: the part's Content-Type (files default to one guessed from the name). */
  contentType?: string;
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
  /** GraphQL operation to run when the query defines several; blank picks the first. */
  graphqlOperationName?: string;
  /** binary: file path (relative to the workspace, or absolute). */
  binaryFile: string;
}

export interface RequestSettings {
  /** Per-request timeout in ms; 0 means the app default. */
  timeoutMs: number;
  followRedirects: boolean;
  skipSslVerification: boolean;
  /** Redirects followed before giving up (and showing the last 3xx). */
  maxRedirects: number;
  /** Keep the method and body on 301/302 instead of switching to GET. */
  followOriginalMethod: boolean;
  /** Keep Authorization and Cookie headers when a redirect goes to another host. */
  followAuthorizationHeader: boolean;
  /** Neither send cookies from the jar nor store the ones the response sets. */
  disableCookieJar: boolean;
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
  /** The request that produced this response (headers are left out: they can hold credentials). */
  request?: { method: string; url: string; body?: string };
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
  /** Used by requests inside that inherit; "inherit" passes on to the parent folder or collection. */
  auth?: Auth;
  /** Run between the collection's script and the request's (pre: outer folders first). */
  preRequestScript?: string;
  postResponseScript?: string;
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
  /** Files that couldn't be read (e.g. Git conflict markers); Yamlet leaves them untouched. */
  problems?: { path: string; message: string }[];
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
  /** Phases of opening a new connection; absent when a kept-alive one was reused. */
  dns?: number;
  tcp?: number;
  tls?: number;
  /** True when the final request went over an already open connection. */
  reusedConnection?: boolean;
}

/** Where the final request actually went. */
export interface NetworkInfo {
  httpVersion?: string;
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
  tls?: {
    protocol?: string;
    cipher?: string;
    /** The server's certificate. */
    certificate?: { subject?: string; issuer?: string; validFrom?: string; validTo?: string; altNames?: string };
    /** Why the certificate would be rejected, when verification was skipped. */
    authorizationError?: string;
  };
}

export interface YamletResponse {
  statusCode: number;
  reasonPhrase: string;
  durationMs: number;
  /** Body size after decompression. */
  sizeBytes: number;
  /** Body size on the wire, when it was compressed. */
  encodedSizeBytes?: number;
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
  network?: NetworkInfo;
  /** Redirects followed before the final response, in order: the status and the URL that sent it. */
  redirects?: { statusCode: number; url: string }[];
  testResults: ScriptTestResult[];
  /** console.log output from pre/post scripts. */
  scriptLogs: string[];
  /** Readable snapshot of the exchange (request line, headers, body). */
  consoleText: string;
  isError: boolean;
  errorMessage?: string;
  /** Set when the body broke off (timeout or dropped connection) after the headers arrived. */
  incomplete?: string;
  /** A pre-request script called pm.execution.skipRequest(); nothing was sent. */
  skipped?: boolean;
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
    audience: "",
    resource: "",
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
    aws: { accessKey: "", secretKey: "", sessionToken: "", region: "us-east-1", service: "" },
  };
}

export function defaultBody(): RequestBody {
  return { type: "none", raw: "", fields: [], graphqlQuery: "", graphqlVariables: "", binaryFile: "" };
}

export function defaultSettings(): RequestSettings {
  return { timeoutMs: 0, followRedirects: true, skipSslVerification: false, maxRedirects: 10, followOriginalMethod: false, followAuthorizationHeader: false, disableCookieJar: false };
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
  return { id: newId(), name: "New Folder", folders: [], requests: [], order: 0, auth: defaultAuth("inherit"), preRequestScript: "", postResponseScript: "", ...partial };
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

/**
 * Script changes as current values: a file-stored variable whose value changed keeps its
 * file (initial) value and gets the new one as an override; a variable the script added
 * starts with a blank file value. Local variables are left as they are.
 */
export function asCurrentValues(previous: readonly Variable[], next: Variable[]): Variable[] {
  const before = new Map(previous.map((v) => [v.key, v]));
  const out = next.map((v) => {
    if (v.local) return v;
    const old = before.get(v.key);
    const fileValue = old ? (old.initialValue ?? old.value) : "";
    const { initialValue: _drop, ...rest } = v;
    return v.value === fileValue ? rest : { ...rest, initialValue: fileValue };
  });
  // unset() / clear() drop only the current value: the file keeps the key and its
  // initial value (a local variable keeps its key, blank), in its old place.
  const kept = new Set(next.map((v) => v.key));
  previous.forEach((old, i) => {
    if (kept.has(old.key)) return;
    const { initialValue, ...rest } = old;
    const restored = old.local ? { ...rest, value: "" } : { ...rest, value: initialValue ?? old.value };
    out.splice(Math.min(i, out.length), 0, restored);
  });
  return out;
}

/** QUERY is the safe, idempotent method that carries a body (like GET with a search payload). */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "QUERY", "HEAD", "OPTIONS"] as const;

let yamletVersion = "dev";

/** A client certificate (mTLS) used for one host, or `*.domain` hosts. */
export interface ClientCertificate {
  /** `api.example.com`, `api.example.com:8443` or `*.example.com`. */
  host: string;
  /** PEM certificate and key files, or a PKCS#12 (.pfx/.p12) file instead. */
  certPath: string;
  keyPath: string;
  pfxPath: string;
  passphrase: string;
}

export type ProxyMode = "none" | "system" | "custom";

/** How Yamlet reaches servers; kept in the data folder, not in the workspace. */
export interface NetworkSettings {
  /** Verify server certificates unless a request turns it off. */
  verifySsl: boolean;
  /** Offer HTTP/2 to HTTPS servers (negotiated with ALPN; on unless false). Off forces HTTP/1.1. */
  http2?: boolean;
  /** Extra trusted CA certificates (PEM files) on top of the built-in ones. */
  caCertificatePaths: string[];
  clientCertificates: ClientCertificate[];
  /**
   * `system` uses HTTP_PROXY / HTTPS_PROXY / NO_PROXY from the environment; `custom` uses
   * `url` (credentials may be in it) for both, skipping hosts in `bypass` (comma-separated).
   */
  proxy: { mode: ProxyMode; url: string; bypass: string };
}

/** Machine-wide preferences, edited in Settings. */
export interface AppSettings {
  /** Default request timeout in ms; 0 means none. A request's own timeout wins. */
  timeoutMs: number;
  /** Response bodies are cut off past this many MB; 0 keeps everything. */
  maxResponseMb: number;
  network: NetworkSettings;
}

export function defaultNetworkSettings(): NetworkSettings {
  return { verifySsl: true, http2: true, caCertificatePaths: [], clientCertificates: [], proxy: { mode: "system", url: "", bypass: "" } };
}

export function defaultAppSettings(): AppSettings {
  return { timeoutMs: 0, maxResponseMb: 50, network: defaultNetworkSettings() };
}

/** Sent with every request unless the request sets its own; compressed bodies are decoded. */
export const DEFAULT_REQUEST_HEADERS: readonly { key: string; value: string }[] = [
  { key: "Accept", value: "*/*" },
  { key: "Accept-Encoding", value: "gzip, deflate, br" },
];

/** Sets the version in the User-Agent; the server, CLI and UI call this at startup. */
export function setYamletVersion(version: string): void {
  yamletVersion = version.trim().replace(/^v(?=\d)/, "") || "dev";
}

/** The User-Agent every request carries, e.g. `Yamlet/1.2.0`; shown as a locked header row in the UI. */
export function yamletUserAgent(): string {
  return `Yamlet/${yamletVersion}`;
}
