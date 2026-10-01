// On-disk YAML shapes and their mapping to the domain model. Yamlet writes only its
// native format; the readers also accept the shapes produced by other tools' exports
// and by older Yamlet versions (see the "imported format" notes on each reader).
import { Document, isAlias, isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import {
  defaultAuth,
  defaultBody,
  defaultOAuth2,
  defaultSettings,
  newId,
  type Auth,
  type AuthType,
  type BodyField,
  type BodyType,
  type KeyValue,
  type OAuth2Config,
  type OAuth2GrantType,
  type PathVariable,
  type RequestBody,
  type RequestSettings,
  type ResponseExample,
  type Variable,
  type YamletCollection,
  type YamletEnvironment,
  type YamletFolder,
  type YamletRequest,
} from "./models.js";

export type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// YAML I/O

/**
 * Parses YAML into plain data. Numeric scalars come back as their source text so values
 * like `1.0` or `0x10` survive as written (all modeled values are strings anyway).
 */
export function loadYaml(text: string): unknown {
  if (!text?.trim()) return {};
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length) throw doc.errors[0];
  const toPlain = (n: unknown): unknown => {
    if (isAlias(n)) return toPlain(n.resolve(doc));
    if (isMap(n)) {
      const o: Obj = {};
      for (const p of n.items) {
        const k = isScalar(p.key) ? String(p.key.value ?? "") : String(p.key ?? "");
        o[k] = toPlain(p.value);
      }
      return o;
    }
    if (isSeq(n)) return n.items.map(toPlain);
    if (isScalar(n)) {
      if (typeof n.value === "number" || typeof n.value === "bigint") return n.source ?? String(n.value);
      return n.value;
    }
    return n ?? null;
  };
  return toPlain(doc.contents) ?? {};
}

const STRINGIFY_OPTS = { lineWidth: 0 } as const;

export function dumpYaml(value: unknown): string {
  return stringify(value, STRINGIFY_OPTS);
}

/**
 * Serializes `value`, then appends top-level keys from `original` that Yamlet does not
 * model (e.g. `$kind`, `tests`). Keys in `known` are modeled (or are read-only aliases)
 * and are never copied back, so removing data in the UI actually removes it.
 */
export function dumpYamlPreserving(value: Obj, original: string | undefined, known: ReadonlySet<string>): string {
  if (!original?.trim()) return dumpYaml(value);
  try {
    const orig = parseDocument(original);
    if (orig.errors.length || !isMap(orig.contents)) return dumpYaml(value);
    const doc = new Document(value);
    const target = doc.contents;
    if (!isMap(target)) return dumpYaml(value);
    for (const pair of orig.contents.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (!key || known.has(key) || isDropped(key) || doc.has(key)) continue;
      target.items.push(pair as (typeof target.items)[number]);
    }
    return doc.toString(STRINGIFY_OPTS);
  } catch {
    return dumpYaml(value);
  }
}

/** Exporter bookkeeping keys (`_<tool>_id`, `_<tool>_variable_scope`, ...) are not carried over. */
const isDropped = (key: string) => /^_[a-z0-9]+_[a-z_]+$/i.test(key);

// ---------------------------------------------------------------------------
// Primitive readers

export const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join("\n");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : str(v));

function bool(v: unknown): boolean | undefined {
  if (v === true || v === false) return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return undefined;
}

function int(v: unknown): number | undefined {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Math.trunc(Number(v));
  return undefined;
}

/** Native `enabled:` (default true) or the imported `disabled:` flag, which wins when present. */
function readEnabled(o: Obj): boolean {
  const disabled = bool(o.disabled);
  if (disabled !== undefined) return !disabled;
  return bool(o.enabled) ?? true;
}


/** Reads a key/value list; also accepts a `name: value` map (imported headers / variables). */
function readRows(raw: unknown): { key: string; value: string; description?: string; enabled: boolean; o: Obj }[] {
  if (Array.isArray(raw)) {
    return raw
      .filter(isObj)
      .map((o) => ({ key: str(o.key ?? o.name), value: str(o.value), description: optStr(o.description), enabled: readEnabled(o), o }));
  }
  if (isObj(raw)) {
    return Object.entries(raw).map(([key, value]) => ({ key, value: str(value), enabled: true, o: {} }));
  }
  return [];
}

export function readKeyValues(raw: unknown): KeyValue[] {
  return readRows(raw).map((r) => {
    const kv: KeyValue = { key: r.key, value: r.value, enabled: r.enabled };
    if (r.description) kv.description = r.description;
    return kv;
  });
}

export function readVariables(raw: unknown): Variable[] {
  return readRows(raw).map((r) => {
    const v: Variable = { key: r.key, value: r.value, enabled: r.enabled };
    if (str(r.o.type).toLowerCase() === "secret" || bool(r.o.secret) === true) v.secret = true;
    return v;
  });
}

function writeKeyValues(list: KeyValue[] | undefined): Obj[] | undefined {
  if (!list?.length) return undefined;
  return list.map((kv) => {
    const o: Obj = { key: kv.key, value: kv.value ?? "" };
    if (kv.description) o.description = kv.description;
    if (kv.enabled === false) o.enabled = false;
    return o;
  });
}

export function writeVariables(list: Variable[] | undefined): Obj[] | undefined {
  if (!list?.length) return undefined;
  return list.map((v) => {
    const o: Obj = { key: v.key, value: v.value ?? "" };
    if (v.secret) o.type = "secret";
    if (v.enabled === false) o.enabled = false;
    return o;
  });
}

// ---------------------------------------------------------------------------
// Auth

function authType(raw: unknown): AuthType {
  switch (str(raw).trim().toLowerCase()) {
    case "bearer":
      return "bearer";
    case "basic":
      return "basic";
    case "apikey":
    case "api-key":
    case "api_key":
      return "apikey";
    case "cookie":
      return "cookie";
    case "oauth2":
      return "oauth2";
    case "inherit":
    case "inherited":
      return "inherit";
    default:
      return "none";
  }
}

function grantType(raw: unknown): OAuth2GrantType {
  switch (str(raw).trim().toLowerCase()) {
    case "authorization_code":
    case "authorization-code":
    case "authorization_code_with_pkce":
      return "authorization_code";
    case "password":
    case "password_credentials":
      return "password";
    default:
      return "client_credentials";
  }
}

/** Looks up a value in an imported credential list (`[{key: token, value: ...}]`) or object. */
function credential(block: unknown, key: string): string | undefined {
  if (Array.isArray(block)) {
    const hit = block.filter(isObj).find((kv) => str(kv.key).toLowerCase() === key.toLowerCase());
    return hit ? str(hit.value) : undefined;
  }
  if (isObj(block)) {
    const k = Object.keys(block).find((x) => x.toLowerCase() === key.toLowerCase());
    return k ? str(block[k]) : undefined;
  }
  return undefined;
}

/** OAuth2 `credentials:` block. Keys mix camelCase and snake_case, as exported files do. */
export function readOAuth2(o: unknown): OAuth2Config {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = credential(o, k);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const d = defaultOAuth2();
  const addTo = (get("addTokenTo") ?? "").toLowerCase();
  const clientAuth = (get("client_authentication", "clientAuthentication") ?? "").toLowerCase();
  const challenge = get("challengeAlgorithm");
  return {
    grantType: grantType(get("grant_type", "grantType")),
    accessToken: get("accessToken", "access_token") ?? "",
    refreshToken: get("refreshToken", "refresh_token") ?? "",
    headerPrefix: get("headerPrefix", "tokenType")?.trim() || d.headerPrefix,
    accessTokenUrl: get("accessTokenUrl", "tokenUrl", "access_token_url") ?? "",
    authUrl: get("authUrl", "authorizationUrl", "auth_url") ?? "",
    clientId: get("clientId", "client_id") ?? "",
    clientSecret: get("clientSecret", "client_secret") ?? "",
    scope: get("scope") ?? "",
    redirectUri: get("redirect_uri", "redirectUri", "redirect_url", "callbackUrl") ?? "",
    username: get("username") ?? "",
    password: get("password") ?? "",
    addTokenTo: addTo === "queryparams" || addTo === "query" ? "query" : "header",
    clientAuthentication: clientAuth === "body" ? "body" : "basic",
    challengeAlgorithm: challenge?.trim().toLowerCase() === "plain" ? "plain" : "S256",
  };
}

/**
 * Reads an auth block in any supported shape: Yamlet's flat fields (`token`, `username`,
 * `key`/`value`/`in`, `cookie`, `credentials`), or the imported per-type credential lists
 * (`bearer: [{key: token, value: ...}]`, also the older object form `bearer: {token: ...}`).
 */
export function readAuth(raw: unknown, fallback: AuthType = "none"): Auth {
  if (!isObj(raw)) return defaultAuth(fallback);
  const type = raw.type === undefined ? fallback : authType(raw.type);
  const a = defaultAuth(type);
  const typed = (name: string) => raw[name];
  a.token = credential(typed("bearer"), "token") ?? str(raw.token);
  a.username = credential(typed("basic"), "username") ?? str(raw.username);
  a.password = credential(typed("basic"), "password") ?? str(raw.password);
  a.apiKeyName = credential(typed("apikey"), "key") ?? str(raw.key);
  a.apiKeyValue = credential(typed("apikey"), "value") ?? str(raw.value);
  a.apiKeyIn = (credential(typed("apikey"), "in") ?? str(raw.in)).toLowerCase() === "query" ? "query" : "header";
  a.cookie = str(raw.cookie);
  if (isObj(raw.credentials)) a.oauth2 = readOAuth2(raw.credentials);
  else if (raw.oauth2 !== undefined) a.oauth2 = readOAuth2(raw.oauth2);
  return a;
}

function writeOAuth2(o: OAuth2Config): Obj {
  const out: Obj = {
    grant_type: o.grantType === "authorization_code" ? "authorization_code" : o.grantType === "password" ? "password_credentials" : "client_credentials",
  };
  const put = (k: string, v: string | undefined) => {
    if (v) out[k] = v;
  };
  put("accessTokenUrl", o.accessTokenUrl);
  put("authUrl", o.authUrl);
  put("clientId", o.clientId);
  put("clientSecret", o.clientSecret);
  put("scope", o.scope);
  put("redirect_uri", o.redirectUri);
  put("username", o.username);
  put("password", o.password);
  put("accessToken", o.accessToken);
  put("refreshToken", o.refreshToken);
  if (o.headerPrefix && o.headerPrefix !== "Bearer") out.tokenType = o.headerPrefix;
  if (o.addTokenTo === "query") out.addTokenTo = "queryParams";
  if (o.clientAuthentication === "body") out.client_authentication = "body";
  if (o.challengeAlgorithm === "plain") out.challengeAlgorithm = "plain";
  return out;
}

/** Writes every non-empty field so switching auth types in the UI does not lose input. */
export function writeAuth(a: Auth): Obj {
  const out: Obj = { type: a.type === "none" ? "noauth" : a.type };
  const put = (k: string, v: string | undefined) => {
    if (v) out[k] = v;
  };
  put("token", a.token);
  put("username", a.username);
  put("password", a.password);
  put("key", a.apiKeyName);
  put("value", a.apiKeyValue);
  if (a.type === "apikey") out.in = a.apiKeyIn === "query" ? "query" : "header";
  put("cookie", a.cookie);
  if (a.type === "oauth2") out.credentials = writeOAuth2(a.oauth2);
  return out;
}

// ---------------------------------------------------------------------------
// Scripts

/** `preRequest` / `afterResponse` (native) and `http:beforeRequest` / `http:afterResponse` (imported). */
export function isPreScriptType(type: unknown): boolean {
  const t = str(type).toLowerCase().replace(/-/g, "");
  return t.includes("pre") || t.includes("before");
}

function readScripts(raw: unknown): { pre: string; post: string } {
  const pre: string[] = [];
  const post: string[] = [];
  if (Array.isArray(raw)) {
    for (const s of raw.filter(isObj)) {
      const code = str(s.code ?? s.exec ?? s.script);
      if (!code) continue;
      (isPreScriptType(s.type) ? pre : post).push(code);
    }
  } else if (isObj(raw)) {
    for (const [type, code] of Object.entries(raw)) {
      const c = str(code);
      if (c) (isPreScriptType(type) ? pre : post).push(c);
    }
  }
  return { pre: pre.join("\n\n"), post: post.join("\n\n") };
}

function writeScripts(pre: string, post: string): Obj[] | undefined {
  const list: Obj[] = [];
  if (pre) list.push({ type: "preRequest", code: pre });
  if (post) list.push({ type: "afterResponse", code: post });
  return list.length ? list : undefined;
}

// ---------------------------------------------------------------------------
// Body

function bodyType(raw: unknown): BodyType {
  switch (str(raw).trim().toLowerCase()) {
    case "raw":
      return "raw";
    case "json":
      return "json";
    case "xml":
      return "xml";
    case "text":
      return "text";
    case "html":
      return "html";
    case "graphql":
      return "graphql";
    case "form-data":
    case "formdata":
    case "multipart-form":
    case "multipart":
      return "form-data";
    case "x-www-form-urlencoded":
    case "urlencoded":
    case "form-urlencoded":
      return "urlencoded";
    case "binary":
    case "file":
      return "binary";
    default:
      return "none";
  }
}

function readField(o: Obj): BodyField {
  const isFile = str(o.type).toLowerCase() === "file" || bool(o.isFile) === true;
  const src = Array.isArray(o.src) ? str(o.src[0]) : optStr(o.src);
  const field: BodyField = {
    key: str(o.key ?? o.name),
    value: isFile ? (src ?? str(o.value)) : str(o.value),
    enabled: readEnabled(o),
  };
  if (o.description !== undefined && o.description !== null) field.description = str(o.description);
  if (isFile) field.isFile = true;
  return field;
}

export function readBody(raw: unknown): RequestBody {
  const b = defaultBody();
  if (!isObj(raw)) return b;
  b.type = bodyType(raw.type ?? raw.mode);
  const content = raw.content;
  b.raw = optStr(raw.raw) ?? (typeof content === "string" ? content : "");
  const fieldsRaw = Array.isArray(raw.fields) ? raw.fields : Array.isArray(content) ? content : undefined;
  if (fieldsRaw) b.fields = fieldsRaw.filter(isObj).map(readField);
  else if (isObj(content) && (b.type === "form-data" || b.type === "urlencoded"))
    b.fields = Object.entries(content).map(([key, value]) => ({ key, value: str(value), enabled: true }));
  const gql = isObj(raw.graphql) ? raw.graphql : raw;
  b.graphqlQuery = str(gql.query);
  b.graphqlVariables = gql.variables === undefined || gql.variables === null ? "" : typeof gql.variables === "string" ? gql.variables : JSON.stringify(gql.variables, null, 2);
  if (b.type === "graphql" && !b.graphqlQuery && b.raw) b.graphqlQuery = b.raw;
  b.binaryFile = str(raw.file ?? raw.binaryFile ?? (b.type === "binary" && typeof raw.src === "string" ? raw.src : ""));
  if (b.type === "binary" && !b.binaryFile && b.raw) b.binaryFile = b.raw;
  return b;
}

function writeField(f: BodyField): Obj {
  const o: Obj = { type: f.isFile ? "file" : "text", key: f.key };
  if (f.isFile) o.src = f.value.startsWith("@") ? f.value.slice(1) : f.value;
  else o.value = f.value ?? "";
  if (f.description) o.description = f.description;
  if (f.enabled === false) o.enabled = false;
  return o;
}

const BODY_TYPE_NAMES: Record<BodyType, string> = {
  none: "none",
  raw: "raw",
  json: "json",
  xml: "xml",
  text: "text",
  html: "html",
  "form-data": "form-data",
  urlencoded: "x-www-form-urlencoded",
  graphql: "graphql",
  binary: "binary",
};

/** Writes the active body plus any inactive content (so switching types keeps input). */
export function writeBody(b: RequestBody): Obj | undefined {
  const out: Obj = { type: BODY_TYPE_NAMES[b.type] ?? "none" };
  if (b.raw) out.raw = b.raw;
  const fields = b.fields?.filter((f) => f.key?.trim() || f.value);
  if (fields?.length) out.content = fields.map(writeField);
  if (b.graphqlQuery || b.graphqlVariables) {
    const g: Obj = {};
    if (b.graphqlQuery) g.query = b.graphqlQuery;
    if (b.graphqlVariables) g.variables = b.graphqlVariables;
    out.graphql = g;
  }
  if (b.binaryFile) out.file = b.binaryFile;
  if (b.type === "none" && Object.keys(out).length === 1) return undefined;
  return out;
}

// ---------------------------------------------------------------------------
// Settings and examples

export function readSettings(o: Obj): RequestSettings {
  const s = defaultSettings();
  const raw = isObj(o.settings) ? o.settings : {};
  s.timeoutMs = int(raw.timeoutMs ?? raw.timeout) ?? 0;
  s.followRedirects = bool(raw.followRedirects) ?? true;
  const ssl = isObj(o.ssl) ? o.ssl : {};
  s.skipSslVerification =
    bool(raw.skipSslVerification) ??
    bool(o.skipSslVerification) ??
    bool(ssl.skipVerification) ??
    (bool(ssl.verify) === false ? true : undefined) ??
    false;
  return s;
}

function writeSettings(s: RequestSettings | undefined): Obj | undefined {
  if (!s) return undefined;
  const out: Obj = {};
  if (s.timeoutMs > 0) out.timeoutMs = s.timeoutMs;
  if (s.followRedirects === false) out.followRedirects = false;
  if (s.skipSslVerification) out.skipSslVerification = true;
  return Object.keys(out).length ? out : undefined;
}

function readExamples(raw: unknown): ResponseExample[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((o) => {
    const e: ResponseExample = {
      id: str(o.id) || newId(),
      name: str(o.name),
      status: int(o.status ?? o.code) ?? 0,
      headers: readKeyValues(o.headers),
      body: str(o.body),
    };
    if (o.contentType) e.contentType = str(o.contentType);
    if (o.savedAt) e.savedAt = str(o.savedAt);
    return e;
  });
}

function writeExamples(list: ResponseExample[] | undefined): Obj[] | undefined {
  if (!list?.length) return undefined;
  return list.map((e) => {
    const o: Obj = { id: e.id, name: e.name, status: e.status };
    const h = writeKeyValues(e.headers);
    if (h) o.headers = h;
    if (e.contentType) o.contentType = e.contentType;
    if (e.body) o.body = e.body;
    if (e.savedAt) o.savedAt = e.savedAt;
    return o;
  });
}

// ---------------------------------------------------------------------------
// Request files

export const REQUEST_KEYS: ReadonlySet<string> = new Set([
  "id", "name", "description", "order", "method", "url", "queryParams", "headers", "pathVariables", "variables",
  "auth", "body", "scripts", "settings", "examples", "skipSslVerification", "ssl",
]);

/** `Get All.request.yaml` -> `Get All`; `health.yaml` -> `health`. */
export function deriveNameFromFile(filePath: string): string {
  let name = filePath.split(/[\\/]/).pop() ?? filePath;
  name = name.replace(/\.ya?ml$/i, "");
  return name.replace(/\.request$/i, "");
}

export function requestFromDto(raw: unknown, sourceFilePath?: string): YamletRequest {
  const o = isObj(raw) ? raw : {};
  const name = str(o.name).trim() ? str(o.name) : sourceFilePath ? deriveNameFromFile(sourceFilePath) : "";
  const scripts = readScripts(o.scripts);
  const req: YamletRequest = {
    id: str(o.id).trim() || newId(),
    name,
    method: str(o.method).trim() ? str(o.method).trim().toUpperCase() : "GET",
    url: str(o.url),
    headers: readKeyValues(o.headers),
    queryParams: readKeyValues(o.queryParams),
    pathVariables: readRows(o.pathVariables).map((r) => {
      const p: PathVariable = { key: r.key, value: r.value };
      if (r.description) p.description = r.description;
      return p;
    }),
    body: readBody(o.body),
    auth: o.auth === undefined || o.auth === null ? defaultAuth("inherit") : readAuth(o.auth, "none"),
    variables: readVariables(o.variables),
    description: str(o.description),
    preRequestScript: scripts.pre,
    postResponseScript: scripts.post,
    settings: readSettings(o),
    examples: readExamples(o.examples),
    order: int(o.order) ?? 0,
  };
  if (sourceFilePath) req.sourceFilePath = sourceFilePath;
  return req;
}

export function requestToDto(r: YamletRequest): Obj {
  const o: Obj = { id: r.id, name: r.name };
  if (r.description) o.description = r.description;
  o.order = r.order ?? 0;
  o.method = (r.method || "GET").toUpperCase();
  o.url = r.url ?? "";
  const put = (k: string, v: unknown) => {
    if (v !== undefined) o[k] = v;
  };
  put("queryParams", writeKeyValues(r.queryParams));
  put("headers", writeKeyValues(r.headers));
  put(
    "pathVariables",
    r.pathVariables?.length
      ? r.pathVariables.map((p) => {
          const x: Obj = { key: p.key, value: p.value ?? "" };
          if (p.description) x.description = p.description;
          return x;
        })
      : undefined,
  );
  put("variables", writeVariables(r.variables));
  if (r.auth && r.auth.type !== "inherit") o.auth = writeAuth(r.auth);
  put("body", r.body ? writeBody(r.body) : undefined);
  put("scripts", writeScripts(r.preRequestScript, r.postResponseScript));
  put("settings", writeSettings(r.settings));
  put("examples", writeExamples(r.examples));
  return o;
}

export function requestFromYaml(text: string, sourceFilePath?: string): YamletRequest {
  return requestFromDto(loadYaml(text), sourceFilePath);
}

/** Native request YAML; unknown top-level keys of `original` are preserved. */
export function requestToYaml(r: YamletRequest, original?: string): string {
  return dumpYamlPreserving(requestToDto(r), original, REQUEST_KEYS);
}

// ---------------------------------------------------------------------------
// Collections

export const COLLECTION_KEYS: ReadonlySet<string> = new Set([
  "id", "name", "description", "order", "variables", "auth", "scripts",
  // Read-only aliases from the collection v2.1 shape; migrated on save.
  "info", "item", "variable", "event",
]);

function eventScript(events: unknown, listen: string): string {
  if (!Array.isArray(events)) return "";
  const ev = events.filter(isObj).find((e) => str(e.listen).toLowerCase() === listen);
  if (!ev) return "";
  const script = isObj(ev.script) ? ev.script : {};
  const exec = script.exec;
  return Array.isArray(exec) ? exec.map(str).join("\n") : str(exec);
}

/**
 * Applies a `collection.yaml` onto a collection. Accepts the native flat shape and the
 * legacy collection v2.1 shape (`info`, `variable`, `event`, list-style `auth`).
 * Merge-friendly: only fields present override, so it can layer over a definition file.
 */
export function applyCollectionMetadata(c: YamletCollection, raw: unknown): void {
  if (!isObj(raw)) return;
  const info = isObj(raw.info) ? raw.info : undefined;
  const legacyIdKey = info ? Object.keys(info).find((k) => /^_[a-z0-9]+_id$/i.test(k)) : undefined;
  const id = (legacyIdKey && str(info![legacyIdKey])) || str(raw.id);
  const name = (info && str(info.name)) || str(raw.name);
  if (id.trim()) c.id = id;
  if (name.trim()) c.name = name;
  const description = (info && optStr(info.description)) ?? optStr(raw.description);
  if (description) c.description = description;
  const order = int(raw.order);
  if (order !== undefined) c.order = order;
  if (isObj(raw.auth)) c.auth = readAuth(raw.auth, "none");

  const legacyVars = Array.isArray(raw.variable) ? readVariables(raw.variable) : [];
  const vars = legacyVars.length ? legacyVars : readVariables(raw.variables);
  if (vars.length) c.variables = vars;

  const scripts = readScripts(raw.scripts);
  const pre = eventScript(raw.event, "prerequest") || scripts.pre;
  const post = eventScript(raw.event, "test") || scripts.post;
  if (pre) c.preRequestScript = pre;
  if (post) c.postResponseScript = post;
}

/**
 * Applies an exported `.resources/definition.yaml`: variables as a name->value map (or
 * list), auth as a list of schemes (the first is used), and collection-scope scripts.
 */
export function applyCollectionDefinition(c: YamletCollection, raw: unknown): void {
  if (!isObj(raw)) return;
  if (str(raw.name).trim()) c.name = str(raw.name);
  if (raw.description) c.description = str(raw.description);
  const vars = readVariables(raw.variables);
  if (vars.length) c.variables = vars;
  const auth = Array.isArray(raw.auth) ? raw.auth.find(isObj) : isObj(raw.auth) ? raw.auth : undefined;
  if (auth) c.auth = readAuth(auth, "none");
  const scripts = readScripts(raw.scripts);
  if (scripts.pre) c.preRequestScript = scripts.pre;
  if (scripts.post) c.postResponseScript = scripts.post;
}

export function collectionToDto(c: YamletCollection): Obj {
  const o: Obj = { id: c.id, name: c.name };
  if (c.description) o.description = c.description;
  o.order = c.order ?? 0;
  const vars = writeVariables(c.variables);
  if (vars) o.variables = vars;
  if (c.auth && c.auth.type !== "none" && c.auth.type !== "inherit") o.auth = writeAuth(c.auth);
  const scripts = writeScripts(c.preRequestScript, c.postResponseScript);
  if (scripts) o.scripts = scripts;
  return o;
}

export function collectionToYaml(c: YamletCollection, original?: string): string {
  return dumpYamlPreserving(collectionToDto(c), original, COLLECTION_KEYS);
}

// ---------------------------------------------------------------------------
// Folders

export const FOLDER_KEYS: ReadonlySet<string> = new Set(["id", "name", "description", "order"]);

export function applyFolderMetadata(f: YamletFolder, raw: unknown): void {
  if (!isObj(raw)) return;
  if (str(raw.id).trim()) f.id = str(raw.id);
  if (str(raw.name).trim()) f.name = str(raw.name);
  if (raw.description) f.description = str(raw.description);
  const order = int(raw.order);
  if (order !== undefined) f.order = order;
}

export function folderToDto(f: YamletFolder): Obj {
  const o: Obj = { id: f.id, name: f.name };
  if (f.description) o.description = f.description;
  o.order = f.order ?? 0;
  return o;
}

export function folderToYaml(f: YamletFolder, original?: string): string {
  return dumpYamlPreserving(folderToDto(f), original, FOLDER_KEYS);
}

// ---------------------------------------------------------------------------
// Environments and globals

export const ENVIRONMENT_KEYS: ReadonlySet<string> = new Set(["id", "name", "variables", "values"]);

/** `staging.environment.yaml` -> `staging`. */
export function deriveEnvironmentName(filePath: string): string {
  return deriveNameFromFile(filePath).replace(/\.environment$/i, "");
}

/** Native `variables:` list, or the imported `values:` list. */
export function environmentFromDto(raw: unknown, filePath?: string): YamletEnvironment {
  const o = isObj(raw) ? raw : {};
  const vars = o.variables !== undefined && o.variables !== null ? o.variables : o.values;
  const env: YamletEnvironment = {
    id: str(o.id).trim() || newId(),
    name: str(o.name).trim() ? str(o.name) : filePath ? deriveEnvironmentName(filePath) : "",
    variables: readVariables(vars),
  };
  if (filePath) env.filePath = filePath;
  return env;
}

export function environmentToDto(e: YamletEnvironment): Obj {
  const o: Obj = { id: e.id, name: e.name };
  const vars = writeVariables(e.variables);
  if (vars) o.variables = vars;
  return o;
}

export function environmentFromYaml(text: string, filePath?: string): YamletEnvironment {
  return environmentFromDto(loadYaml(text), filePath);
}

export function environmentToYaml(e: YamletEnvironment, original?: string): string {
  return dumpYamlPreserving(environmentToDto(e), original, ENVIRONMENT_KEYS);
}

export function globalsFromYaml(text: string): Variable[] {
  const o = loadYaml(text);
  return isObj(o) ? readVariables(o.variables ?? o.values) : [];
}

export function globalsToYaml(vars: Variable[], original?: string): string {
  return dumpYamlPreserving({ variables: writeVariables(vars) ?? [] }, original, new Set(["variables", "values"]));
}
