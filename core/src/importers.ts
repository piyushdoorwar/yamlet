// Importers for the widely used collection v2.0/v2.1 JSON format, environment JSON
// exports, and OpenAPI 3.x / Swagger 2.0 documents. Isomorphic.
import { parse as parseYamlText } from "yaml";
import {
  defaultAuth,
  defaultOAuth2,
  newCollection,
  newEnvironment,
  newFolder,
  newId,
  newRequest,
  type Auth,
  type BodyField,
  type KeyValue,
  type PathVariable,
  type ResponseExample,
  type Variable,
  type YamletCollection,
  type YamletEnvironment,
  type YamletFolder,
  type YamletRequest,
} from "./models.js";
import { readAuth, readVariables } from "./yamlDtos.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

export type ImportFormat = "collection-v2" | "environment" | "openapi" | "curl" | "har" | "link" | "unknown";

function parseStructured(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    try {
      return parseYamlText(t);
    } catch {
      return undefined;
    }
  }
}

export function detectImportFormat(text: string): ImportFormat {
  const t = text.trim();
  if (/^curl(\.exe)?\s/i.test(t)) return "curl";
  // A bare link: the server fetches it and imports what it serves.
  if (/^https?:\/\/\S+$/i.test(t)) return "link";
  const doc = parseStructured(t);
  if (!isObj(doc)) return "unknown";
  if (isObj(doc.log) && Array.isArray(doc.log.entries)) return "har";
  if (typeof doc.openapi === "string" || typeof doc.swagger === "string" || typeof doc.openapi === "number" || typeof doc.swagger === "number") return "openapi";
  const coll = isObj(doc.collection) ? doc.collection : doc;
  if (isObj(coll.info) && (Array.isArray(coll.item) || /collection/i.test(str(coll.info.schema)))) return "collection-v2";
  const env = isObj(doc.environment) ? doc.environment : doc;
  if (Array.isArray(env.values)) return "environment";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Collection v2.x

function description(v: unknown): string {
  if (isObj(v)) return str(v.content);
  return str(v);
}

function eventScript(events: unknown, listen: string): string {
  const ev = arr(events).filter(isObj).find((e) => str(e.listen).toLowerCase() === listen);
  if (!ev) return "";
  const exec = asObj(ev.script).exec;
  const code = Array.isArray(exec) ? exec.map(str).join("\n") : str(exec);
  // A script switched off in the export comes in commented out: kept, but not run.
  if ((ev.disabled === true || asObj(ev.script).disabled === true) && code.trim()) {
    return ["// Disabled in the imported collection:", ...code.split("\n").map((l) => `// ${l}`)].join("\n");
  }
  return code;
}

function v2Auth(raw: unknown, fallback: Auth["type"]): Auth {
  if (!isObj(raw)) return defaultAuth(fallback);
  const type = str(raw.type).toLowerCase();
  if (type === "noauth") return defaultAuth("none");
  if (type === "inherit") return defaultAuth("inherit");
  // The per-type credential lists are read by the shared auth reader.
  return readAuth(raw, "none");
}

function splitRawUrl(raw: string): { base: string; query: KeyValue[] } {
  const noHash = raw.split("#")[0];
  const q = noHash.indexOf("?");
  if (q < 0) return { base: noHash, query: [] };
  const query = noHash
    .slice(q + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      // Kept as written: params are sent as typed, so %2B and + arrive unchanged.
      return { key: eq >= 0 ? pair.slice(0, eq) : pair, value: eq >= 0 ? pair.slice(eq + 1) : "", enabled: true };
    });
  return { base: noHash.slice(0, q), query };
}

function kvRows(list: unknown): KeyValue[] {
  return arr(list)
    .filter(isObj)
    .map((o) => {
      const kv: KeyValue = { key: str(o.key), value: str(o.value), enabled: o.disabled !== true };
      const d = description(o.description);
      if (d) kv.description = d;
      return kv;
    });
}

function v2Url(url: unknown): { url: string; query: KeyValue[]; pathVariables: PathVariable[] } {
  if (typeof url === "string") {
    const { base, query } = splitRawUrl(url);
    return { url: base, query, pathVariables: [] };
  }
  const u = asObj(url);
  let base: string;
  let query: KeyValue[];
  if (typeof u.raw === "string") {
    const split = splitRawUrl(u.raw);
    base = split.base;
    query = split.query;
  } else {
    const host = Array.isArray(u.host) ? u.host.map(str).join(".") : str(u.host);
    const pathPart = Array.isArray(u.path) ? u.path.map(str).join("/") : str(u.path).replace(/^\//, "");
    base = `${u.protocol ? `${str(u.protocol)}://` : ""}${host}${u.port ? `:${str(u.port)}` : ""}${pathPart ? `/${pathPart}` : ""}`;
    query = [];
  }
  if (Array.isArray(u.query)) query = kvRows(u.query);
  const pathVariables = arr(u.variable)
    .filter(isObj)
    .map((o) => {
      const p: PathVariable = { key: str(o.key), value: str(o.value) };
      const d = description(o.description);
      if (d) p.description = d;
      return p;
    });
  return { url: base, query, pathVariables };
}

function v2Body(raw: unknown, headers: KeyValue[], req: YamletRequest): void {
  const b = asObj(raw);
  if (b.disabled === true) return; // the body is switched off: nothing is sent
  const mode = str(b.mode);
  const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  switch (mode) {
    case "raw": {
      req.body.raw = str(b.raw);
      const lang = str(asObj(asObj(b.options).raw).language).toLowerCase();
      req.body.type =
        lang === "json" || (!lang && ct.includes("json"))
          ? "json"
          : lang === "xml" || (!lang && ct.includes("xml"))
            ? "xml"
            : lang === "html"
              ? "html"
              : lang === "javascript" || (!lang && ct.includes("javascript"))
                ? "javascript"
                : lang === "text"
                  ? "text"
                : "raw";
      break;
    }
    case "urlencoded":
      req.body.type = "urlencoded";
      req.body.fields = kvRows(b.urlencoded);
      break;
    case "formdata":
      req.body.type = "form-data";
      req.body.fields = arr(b.formdata)
        .filter(isObj)
        .flatMap((o) => {
          const isFile = str(o.type) === "file";
          // A file row can list several files: one part each, under the same key.
          const sources = isFile ? (Array.isArray(o.src) ? o.src.map(str) : [str(o.src)]) : [str(o.value)];
          return (sources.length ? sources : [""]).map((value) => {
            const f: BodyField = { key: str(o.key), value, enabled: o.disabled !== true };
            if (isFile) f.isFile = true;
            if (str(o.contentType)) f.contentType = str(o.contentType);
            const d = description(o.description);
            if (d) f.description = d;
            return f;
          });
        });
      break;
    case "graphql": {
      const g = asObj(b.graphql);
      req.body.type = "graphql";
      req.body.graphqlQuery = str(g.query);
      req.body.graphqlVariables = typeof g.variables === "string" ? g.variables : g.variables ? JSON.stringify(g.variables, null, 2) : "";
      if (typeof g.operationName === "string" && g.operationName) req.body.graphqlOperationName = g.operationName;
      break;
    }
    case "file":
      req.body.type = "binary";
      req.body.binaryFile = str(asObj(b.file).src);
      break;
  }
}

function v2Examples(responses: unknown): ResponseExample[] {
  return arr(responses)
    .filter(isObj)
    .map((r) => {
      const headers = kvRows(r.header);
      const e: ResponseExample = {
        id: newId(),
        name: str(r.name) || `${str(r.code)} ${str(r.status)}`.trim(),
        status: Number(r.code) || 0,
        headers,
        body: str(r.body),
      };
      const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value;
      if (ct) e.contentType = ct;
      return e;
    });
}

interface Inherited {
  auth?: Auth;
  pre: string[];
  post: string[];
  /** `protocolProfileBehavior` merged from the collection and enclosing folders. */
  behavior: Obj;
  /** Variables of the enclosing folders, nearest last. */
  vars?: Variable[];
}

/** Overlays an item's `protocolProfileBehavior` on what it inherits. */
function behaviorOf(raw: unknown, inherited: Obj): Obj {
  return isObj(raw) ? { ...inherited, ...raw } : inherited;
}

function v2Request(item: Obj, inherited: Inherited): YamletRequest {
  const r = typeof item.request === "string" ? { url: item.request } : asObj(item.request);
  const headers = kvRows(r.header);
  const { url, query, pathVariables } = v2Url(r.url);
  const req = newRequest({
    name: str(item.name) || "Request",
    method: (str(r.method) || "GET").toUpperCase(),
    url,
    headers,
    queryParams: query,
    pathVariables,
    description: description(r.description ?? item.description),
    examples: v2Examples(item.response),
  });
  v2Body(r.body, headers, req);
  req.auth = r.auth === undefined || r.auth === null ? defaultAuth("inherit") : v2Auth(r.auth, "inherit");
  if (req.auth.type === "inherit" && inherited.auth) req.auth = structuredClone(inherited.auth);
  req.preRequestScript = [...inherited.pre, eventScript(item.event, "prerequest")].filter(Boolean).join("\n\n");
  req.postResponseScript = [eventScript(item.event, "test"), ...inherited.post].filter(Boolean).join("\n\n");
  // Folder variables (Yamlet has no folder scope) are copied onto each request inside;
  // the request's own and a nearer folder's win.
  const own = readVariables(item.variable);
  const vars = [...(inherited.vars ?? []).filter((v) => !own.some((o) => o.key === v.key)), ...own];
  if (vars.length) req.variables = vars;
  const behavior = behaviorOf(item.protocolProfileBehavior, inherited.behavior);
  if (behavior.followRedirects === false) req.settings.followRedirects = false;
  if (behavior.strictSSL === false) req.settings.skipSslVerification = true;
  if (typeof behavior.maxRedirects === "number" && behavior.maxRedirects >= 0) req.settings.maxRedirects = behavior.maxRedirects;
  if (behavior.followOriginalHttpMethod === true) req.settings.followOriginalMethod = true;
  if (behavior.followAuthorizationHeader === true) req.settings.followAuthorizationHeader = true;
  if (behavior.disableCookies === true) req.settings.disableCookieJar = true;
  return req;
}

function v2Items(items: unknown, node: YamletCollection | YamletFolder, inherited: Inherited): void {
  for (const raw of arr(items).filter(isObj)) {
    if (Array.isArray(raw.item)) {
      // Folder auth and scripts stay on the folder; requests inherit them when sent.
      const folder = newFolder({ name: str(raw.name) || "Folder", order: node.folders.length });
      const d = description(raw.description);
      if (d) folder.description = d;
      if (raw.auth !== undefined && raw.auth !== null) folder.auth = v2Auth(raw.auth, "inherit");
      folder.preRequestScript = eventScript(raw.event, "prerequest");
      folder.postResponseScript = eventScript(raw.event, "test");
      const folderVars = readVariables(raw.variable);
      const vars = [...(inherited.vars ?? []).filter((v) => !folderVars.some((f) => f.key === v.key)), ...folderVars];
      v2Items(raw.item, folder, { ...inherited, vars, behavior: behaviorOf(raw.protocolProfileBehavior, inherited.behavior) });
      node.folders.push(folder);
    } else {
      const req = v2Request(raw, inherited);
      req.order = node.requests.length;
      node.requests.push(req);
    }
  }
}

/** Imports a collection v2.0 / v2.1 JSON document (optionally wrapped as `{collection: ...}`). */
export function importCollectionV2(json: unknown): YamletCollection {
  const doc = typeof json === "string" ? JSON.parse(json) : json;
  const root = isObj(doc) && isObj(doc.collection) ? doc.collection : asObj(doc);
  const info = asObj(root.info);
  if (!isObj(root.info) && !Array.isArray(root.item)) throw new Error("Not a v2 collection: missing info/item");
  const c = newCollection({ name: str(info.name) || "Imported Collection" });
  const d = description(info.description);
  if (d) c.description = d;
  c.variables = readVariables(root.variable);
  const auth = v2Auth(root.auth, "none");
  c.auth = auth.type === "inherit" ? defaultAuth("none") : auth;
  c.preRequestScript = eventScript(root.event, "prerequest");
  c.postResponseScript = eventScript(root.event, "test");
  v2Items(root.item, c, { pre: [], post: [], behavior: behaviorOf(root.protocolProfileBehavior, {}) });
  return c;
}

/** Imports an environment JSON export (`{name, values: [{key, value, enabled, type}]}`). */
export function importEnvironmentJson(json: unknown): YamletEnvironment {
  const doc = typeof json === "string" ? JSON.parse(json) : json;
  const root = isObj(doc) && isObj(doc.environment) ? doc.environment : asObj(doc);
  if (!Array.isArray(root.values) && !Array.isArray(root.variables)) throw new Error("Not an environment export: missing values");
  return newEnvironment({ name: str(root.name) || "Imported Environment", variables: readVariables(root.values ?? root.variables) });
}

// ---------------------------------------------------------------------------
// OpenAPI 3.x / Swagger 2.0

// OpenAPI 3.2 adds `query` for the QUERY method.
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"] as const;

class RefResolver {
  constructor(
    private readonly doc: Obj,
    private readonly externals: Record<string, unknown> = {},
  ) {}

  /**
   * Follows `$ref`s: local ones (`#/components/...`) and, when the spec came from a link,
   * other files already fetched by `bundleExternalRefs` (`<url>#/...`). Others resolve to `{}`.
   */
  deref(node: unknown, depth = 0): Obj {
    let cur = node;
    for (let i = 0; i < 16 && isObj(cur) && typeof cur.$ref === "string"; i++) {
      const ref = cur.$ref;
      if (depth > 32) return {};
      const hash = ref.indexOf("#");
      const file = hash >= 0 ? ref.slice(0, hash) : ref;
      const pointer = hash >= 0 ? ref.slice(hash + 1) : "";
      const root = file ? this.externals[file] : this.doc;
      if (root === undefined || (pointer && !pointer.startsWith("/"))) return {};
      cur = pointer
        .slice(1)
        .split("/")
        .filter((p, n) => n > 0 || p !== "")
        .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce<unknown>((o, k) => (isObj(o) || Array.isArray(o) ? (o as Obj)[k] : undefined), root);
    }
    return asObj(cur);
  }
}

const MAX_REF_FILES = 30;

/**
 * Fetches the other files a spec's `$ref`s point to (`common.yaml#/User`), relative to the
 * spec's URL, and rewrites every ref to `<absolute url>#<pointer>` so `importOpenApi` can
 * follow them. Files that can't be fetched or read are left out (their refs read as `{}`).
 */
export async function bundleExternalRefs(text: string, url: string, fetchText: (url: string) => Promise<string>): Promise<{ doc: unknown; externals: Record<string, unknown> }> {
  const doc = parseStructured(text);
  // A ref from another file back into the spec itself.
  const externals: Record<string, unknown> = { [url]: doc };
  const queue: string[] = [];
  const rewrite = (node: unknown, base: string, isExternal: boolean): void => {
    if (Array.isArray(node)) for (const n of node) rewrite(n, base, isExternal);
    else if (isObj(node)) {
      if (typeof node.$ref === "string") {
        const ref = node.$ref;
        if (ref.startsWith("#")) {
          if (isExternal) node.$ref = `${base}${ref}`;
        } else {
          const hash = ref.indexOf("#");
          let abs: string;
          try {
            abs = new URL(hash >= 0 ? ref.slice(0, hash) : ref, base).toString();
          } catch {
            return;
          }
          node.$ref = `${abs}${hash >= 0 ? ref.slice(hash) : ""}`;
          if (!(abs in externals) && !queue.includes(abs) && abs !== url) queue.push(abs);
        }
      }
      for (const [k, v] of Object.entries(node)) if (k !== "$ref") rewrite(v, base, isExternal);
    }
  };
  rewrite(doc, url, false);
  for (let n = 0; n < queue.length && n < MAX_REF_FILES; n++) {
    const next = queue[n];
    try {
      const parsed = parseStructured(await fetchText(next));
      externals[next] = parsed ?? {};
      rewrite(parsed, next, true);
    } catch {
      externals[next] = {};
    }
  }
  return { doc, externals };
}

function sample(r: RefResolver, schemaNode: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  const s = r.deref(schemaNode);
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.allOf)) {
    const parts = s.allOf.map((p) => sample(r, p, depth + 1));
    return parts.every((p) => isObj(p)) ? Object.assign({}, ...parts) : parts[0];
  }
  for (const k of ["oneOf", "anyOf"] as const) {
    const list = s[k];
    if (Array.isArray(list) && list.length) return sample(r, list[0], depth + 1);
  }
  let type = s.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null") ?? type[0];
  if (type === "object" || (!type && isObj(s.properties))) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(asObj(s.properties))) {
      if (asObj(r.deref(v)).readOnly === true) continue;
      out[k] = sample(r, v, depth + 1);
    }
    if (!Object.keys(out).length && isObj(s.additionalProperties)) out.key = sample(r, s.additionalProperties, depth + 1);
    return out;
  }
  if (type === "array") return s.items ? [sample(r, s.items, depth + 1)] : [];
  if (type === "integer" || type === "number") return typeof s.minimum === "number" ? s.minimum : 0;
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (type === "string") {
    switch (s.format) {
      case "date-time":
        return "2024-01-01T00:00:00Z";
      case "date":
        return "2024-01-01";
      case "email":
        return "user@example.com";
      case "uuid":
        return "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      case "uri":
      case "url":
        return "https://example.com";
      case "binary":
      case "byte":
        return "";
      default:
        return "string";
    }
  }
  return "";
}

const scalarText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** A parameter's example as given (an array stays an array). */
function paramExampleValue(r: RefResolver, p: Obj): unknown {
  if (p.example !== undefined) return p.example;
  if (p["x-example"] !== undefined) return p["x-example"]; // Swagger 2 extension
  const examples = asObj(p.examples);
  const first = Object.values(examples)[0];
  if (first !== undefined) return r.deref(first).value;
  // A parameter described by `content` (e.g. JSON in a query string).
  const media = Object.values(asObj(p.content)).filter(isObj)[0];
  if (media) return mediaExample(r, media);
  const schema = p.schema ? r.deref(p.schema) : p; // Swagger 2 puts type/default on the parameter
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  return undefined;
}

function paramExample(r: RefResolver, p: Obj): string {
  return scalarText(paramExampleValue(r, p));
}

/**
 * A query parameter's values: an array example is repeated (`ids=1&ids=2`) in the default
 * form style, joined with commas when `explode` is false (or Swagger 2's `csv`).
 */
function queryValues(r: RefResolver, p: Obj): string[] {
  const v = paramExampleValue(r, p);
  if (!Array.isArray(v)) return [scalarText(v)];
  const items = v.map(scalarText);
  if (p.collectionFormat === "multi" || (p.collectionFormat === undefined && p.explode !== false && (p.style === undefined || p.style === "form"))) return items.length ? items : [""];
  const sep = p.collectionFormat === "ssv" || p.style === "spaceDelimited" ? " " : p.collectionFormat === "pipes" || p.style === "pipeDelimited" ? "|" : p.collectionFormat === "tsv" ? "\t" : ",";
  return [items.join(sep)];
}

function mediaExample(r: RefResolver, media: Obj): unknown {
  if (media.example !== undefined) return media.example;
  const first = Object.values(asObj(media.examples))[0];
  if (first !== undefined) return r.deref(first).value;
  return media.schema ? sample(r, media.schema) : undefined;
}

const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

function schemaFields(r: RefResolver, schemaNode: unknown, multipart: boolean): BodyField[] {
  const schema = r.deref(schemaNode);
  const required = new Set(arr(schema.required).map(str));
  return Object.entries(asObj(schema.properties)).map(([key, v]) => {
    const p = r.deref(v);
    const isFile = multipart && (p.format === "binary" || p.format === "base64" || p.type === "file");
    const f: BodyField = { key, value: isFile ? "" : scalarText(sample(r, p)), enabled: required.size === 0 || required.has(key) };
    if (isFile) f.isFile = true;
    if (p.description) f.description = str(p.description);
    return f;
  });
}

function pickMedia(content: Obj): [string, Obj] | undefined {
  const entries = Object.entries(content).map(([k, v]) => [k, asObj(v)] as [string, Obj]);
  const prefs = [/^application\/json/i, /\+json/i, /x-www-form-urlencoded/i, /multipart\/form-data/i, /xml/i, /^text\//i];
  for (const re of prefs) {
    const hit = entries.find(([k]) => re.test(k));
    if (hit) return hit;
  }
  return entries[0];
}

function applyMediaBody(r: RefResolver, req: YamletRequest, mediaType: string, media: Obj): void {
  const mt = mediaType.toLowerCase();
  if (mt.includes("x-www-form-urlencoded")) {
    req.body.type = "urlencoded";
    req.body.fields = schemaFields(r, media.schema, false);
  } else if (mt.includes("multipart/form-data")) {
    req.body.type = "form-data";
    req.body.fields = schemaFields(r, media.schema, true);
  } else if (mt.includes("json")) {
    req.body.type = "json";
    const ex = mediaExample(r, media);
    req.body.raw = ex === undefined ? "" : pretty(ex);
    if (mt !== "application/json") req.headers.push({ key: "Content-Type", value: mediaType, enabled: true });
  } else if (mt.includes("xml")) {
    req.body.type = "xml";
    const ex = media.example ?? Object.values(asObj(media.examples)).map((e) => r.deref(e).value)[0];
    req.body.raw = typeof ex === "string" ? ex : "";
  } else if (mt.startsWith("text/")) {
    req.body.type = mt === "text/html" ? "html" : "text";
    const ex = mediaExample(r, media);
    req.body.raw = typeof ex === "string" ? ex : ex === undefined ? "" : pretty(ex);
  } else if (mt === "application/octet-stream" || mt.startsWith("image/") || mt.startsWith("application/pdf")) {
    req.body.type = "binary";
    req.headers.push({ key: "Content-Type", value: mediaType, enabled: true });
  }
}

interface SchemeAuth {
  auth: Auth;
  vars: Variable[];
}

function securityAuth(scheme: Obj, name: string): SchemeAuth | undefined {
  const type = str(scheme.type).toLowerCase();
  const secret = (key: string): Variable => ({ key, value: "", enabled: true, secret: true });
  if ((type === "http" && str(scheme.scheme).toLowerCase() === "bearer") || type === "bearer") {
    return { auth: { ...defaultAuth("bearer"), token: "{{bearerToken}}" }, vars: [secret("bearerToken")] };
  }
  if (type === "http" && str(scheme.scheme).toLowerCase() === "digest") {
    return {
      auth: { ...defaultAuth("digest"), username: "{{username}}", password: "{{password}}" },
      vars: [{ key: "username", value: "", enabled: true }, secret("password")],
    };
  }
  if ((type === "http" && str(scheme.scheme).toLowerCase() === "basic") || type === "basic") {
    return {
      auth: { ...defaultAuth("basic"), username: "{{username}}", password: "{{password}}" },
      vars: [{ key: "username", value: "", enabled: true }, secret("password")],
    };
  }
  if (type === "apikey") {
    const keyName = str(scheme.name) || name;
    const where = str(scheme.in).toLowerCase();
    if (where === "cookie") return { auth: { ...defaultAuth("cookie"), cookie: `${keyName}={{apiKey}}` }, vars: [secret("apiKey")] };
    return {
      auth: { ...defaultAuth("apikey"), apiKeyName: keyName, apiKeyValue: "{{apiKey}}", apiKeyIn: where === "query" ? "query" : "header" },
      vars: [secret("apiKey")],
    };
  }
  if (type === "oauth2" || type === "openidconnect") {
    const o = defaultOAuth2();
    o.clientId = "{{clientId}}";
    o.clientSecret = "{{clientSecret}}";
    const flows = asObj(scheme.flows);
    const pickScopes = (f: Obj) => Object.keys(asObj(f.scopes)).join(" ");
    if (isObj(flows.clientCredentials) || scheme.flow === "application") {
      const f = isObj(flows.clientCredentials) ? flows.clientCredentials : scheme;
      o.grantType = "client_credentials";
      o.accessTokenUrl = str(f.tokenUrl);
      o.scope = pickScopes(f);
    } else if (isObj(flows.authorizationCode) || scheme.flow === "accessCode") {
      const f = isObj(flows.authorizationCode) ? flows.authorizationCode : scheme;
      o.grantType = "authorization_code";
      o.authUrl = str(f.authorizationUrl);
      o.accessTokenUrl = str(f.tokenUrl);
      o.scope = pickScopes(f);
    } else if (isObj(flows.password) || scheme.flow === "password") {
      const f = isObj(flows.password) ? flows.password : scheme;
      o.grantType = "password";
      o.accessTokenUrl = str(f.tokenUrl);
      o.username = "{{username}}";
      o.password = "{{password}}";
      o.scope = pickScopes(f);
    } else if (isObj(flows.implicit) || scheme.flow === "implicit") {
      const f = isObj(flows.implicit) ? flows.implicit : scheme;
      o.grantType = "implicit";
      o.authUrl = str(f.authorizationUrl);
      o.scope = pickScopes(f);
    } else o.grantType = "authorization_code";
    const vars: Variable[] = [{ key: "clientId", value: "", enabled: true }, secret("clientSecret")];
    if (o.grantType === "password") vars.push({ key: "username", value: "", enabled: true }, secret("password"));
    return { auth: { ...defaultAuth("oauth2"), oauth2: o }, vars };
  }
  return undefined;
}

/**
 * The API's base URL. One given relative to the document (no host, `/v1`, or no servers
 * at all) is resolved against the URL it was imported from, or else starts with a
 * `{{host}}` placeholder to fill in.
 */
function serverUrl(doc: Obj, sourceUrl?: string): { url: string; relative: boolean } {
  let url: string;
  if (typeof doc.swagger === "string" || typeof doc.swagger === "number") {
    const host = str(doc.host);
    const basePath = str(doc.basePath);
    const scheme = arr(doc.schemes).map(str)[0] || "https";
    url = host ? `${scheme}://${host}${basePath}` : basePath || "/";
  } else {
    const server = arr(doc.servers).filter(isObj)[0];
    // Server variables become {{placeholders}}, with their defaults as collection variables.
    url = server ? str(server.url) || "/" : "/";
    for (const k of Object.keys(asObj(server?.variables))) url = url.split(`{${k}}`).join(`{{${k}}}`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith("{{")) return { url: url.replace(/\/$/, ""), relative: false };
  if (url.startsWith("//")) return { url: `https:${url}`.replace(/\/$/, ""), relative: false };
  if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
    const src = new URL(sourceUrl);
    const path = url.startsWith("/") ? url : src.pathname.replace(/[^/]*$/, "") + url;
    return { url: `${src.origin}${path}`.replace(/\/$/, ""), relative: false };
  }
  return { url: `{{host}}${url.startsWith("/") ? url : `/${url}`}`.replace(/\/$/, ""), relative: true };
}

function serverVariables(doc: Obj): Variable[] {
  const server = arr(doc.servers).filter(isObj)[0];
  return Object.entries(asObj(server?.variables)).map(([key, v]) => ({ key, value: str(asObj(v).default), enabled: true }));
}

/** Imports an OpenAPI 3.x or Swagger 2.0 document given as JSON or YAML text. */
/** `text` is the spec, or a spec already parsed by `bundleExternalRefs` with its other files. */
export function importOpenApi(text: string | { doc: unknown; externals: Record<string, unknown> }, opts: { sourceUrl?: string } = {}): YamletCollection {
  const parsed = typeof text === "string" ? parseStructured(text) : text.doc;
  if (!isObj(parsed)) throw new Error("Not a JSON or YAML document");
  const doc = parsed;
  const isSwagger2 = doc.swagger !== undefined;
  if (!isSwagger2 && doc.openapi === undefined) throw new Error("Not an OpenAPI or Swagger document");
  const r = new RefResolver(doc, typeof text === "string" ? {} : text.externals);
  const info = asObj(doc.info);
  const c = newCollection({ name: str(info.title) || "Imported API" });
  if (info.description) c.description = str(info.description);
  const base = serverUrl(doc, opts.sourceUrl);
  c.variables = [{ key: "baseUrl", value: base.url, enabled: true }, ...(isSwagger2 ? [] : serverVariables(doc))];

  const schemes = isSwagger2 ? asObj(doc.securityDefinitions) : asObj(asObj(doc.components).securitySchemes);
  // Schemes Yamlet can't apply, and requirements that combine several, end up in a note.
  const notes = new Set<string>();
  const schemeAuth = (requirements: unknown): SchemeAuth | undefined => {
    for (const req of arr(requirements).filter(isObj)) {
      const names = Object.keys(req);
      for (const name of names) {
        const scheme = r.deref(schemes[name]);
        const hit = securityAuth(scheme, name);
        if (hit) {
          if (names.length > 1) notes.add(`"${names.join('" and "')}" are required together; only "${name}" is set as auth, so add the others as headers or params.`);
          return hit;
        }
        notes.add(`"${name}" (${[str(scheme.type), str(scheme.scheme)].filter(Boolean).join(" ") || "unknown type"}) isn't supported; set up its auth by hand.`);
      }
    }
    return undefined;
  };
  const addVars = (vars: Variable[]) => {
    for (const v of vars) if (!c.variables.some((x) => x.key === v.key)) c.variables.push(v);
  };
  const globalAuth = schemeAuth(doc.security);
  if (globalAuth) {
    c.auth = globalAuth.auth;
    addVars(globalAuth.vars);
  }

  const folders = new Map<string, YamletFolder>();
  const consumesDefault = arr(doc.consumes).map(str);

  for (const [pathKey, pathItemRaw] of Object.entries(asObj(doc.paths))) {
    const pathItem = r.deref(pathItemRaw);
    const common = arr(pathItem.parameters).map((p) => r.deref(p));
    for (const method of METHODS) {
      if (!isObj(pathItem[method])) continue;
      const op = pathItem[method] as Obj;
      const params = new Map<string, Obj>();
      for (const p of [...common, ...arr(op.parameters).map((x) => r.deref(x))]) params.set(`${str(p.in)}:${str(p.name)}`, p);

      const req = newRequest({
        name: str(op.summary) || str(op.operationId) || `${method.toUpperCase()} ${pathKey}`,
        method: method.toUpperCase(),
        url: "{{baseUrl}}" + pathKey.replace(/\{([^}]+)\}/g, ":$1"),
        description: str(op.description),
      });
      const cookies: string[] = [];
      const formParams: Obj[] = [];
      for (const p of params.values()) {
        const name = str(p.name);
        const value = paramExample(r, p);
        const desc = p.description ? str(p.description) : undefined;
        switch (str(p.in)) {
          case "path":
            req.pathVariables.push(desc ? { key: name, value, description: desc } : { key: name, value });
            break;
          case "query":
            for (const v of queryValues(r, p)) req.queryParams.push({ key: name, value: v, enabled: p.required === true, ...(desc ? { description: desc } : {}) });
            break;
          case "header":
            req.headers.push({ key: name, value, enabled: p.required === true, ...(desc ? { description: desc } : {}) });
            break;
          case "cookie":
            cookies.push(`${name}=${value}`);
            break;
          case "body":
            req.body.type = "json";
            req.body.raw = pretty(p["x-example"] ?? sample(r, p.schema) ?? {});
            break;
          case "formData":
            formParams.push(p);
            break;
        }
      }
      if (cookies.length) req.headers.push({ key: "Cookie", value: cookies.join("; "), enabled: false });

      if (isSwagger2) {
        const consumes = arr(op.consumes).map(str).length ? arr(op.consumes).map(str) : consumesDefault;
        if (formParams.length) {
          const multipart = consumes.some((x) => x.includes("multipart")) || formParams.some((p) => p.type === "file");
          req.body.type = multipart ? "form-data" : "urlencoded";
          req.body.fields = formParams.map((p) => {
            const isFile = p.type === "file";
            const f: BodyField = { key: str(p.name), value: isFile ? "" : paramExample(r, p), enabled: true };
            if (isFile) f.isFile = true;
            return f;
          });
        } else if (req.body.type === "json" && consumes.length && !consumes.some((x) => x.includes("json")) && consumes.some((x) => x.includes("xml"))) {
          req.body.type = "xml";
          req.body.raw = "";
        }
      } else if (op.requestBody) {
        const media = pickMedia(asObj(r.deref(op.requestBody).content));
        if (media) applyMediaBody(r, req, media[0], media[1]);
      }

      // Responses with explicit examples become saved examples.
      for (const [code, respRaw] of Object.entries(asObj(op.responses))) {
        const resp = r.deref(respRaw);
        const status = Number(code) || 0;
        if (isSwagger2) {
          for (const [ct, ex] of Object.entries(asObj(resp.examples))) {
            req.examples.push({ id: newId(), name: `${code} ${str(resp.description)}`.trim(), status, headers: [], body: pretty(ex), contentType: ct });
          }
        } else {
          for (const [ct, mRaw] of Object.entries(asObj(resp.content))) {
            const m = asObj(mRaw);
            const ex = m.example !== undefined ? m.example : Object.values(asObj(m.examples)).map((e) => r.deref(e).value)[0];
            if (ex !== undefined) req.examples.push({ id: newId(), name: `${code} ${str(resp.description)}`.trim(), status, headers: [], body: pretty(ex), contentType: ct });
          }
        }
      }

      if (Array.isArray(op.security)) {
        if (!op.security.length) req.auth = defaultAuth("none");
        else {
          const opAuth = schemeAuth(op.security);
          // Only unsupported schemes: no auth rather than another scheme's credentials.
          if (!opAuth && op.security.some((s) => isObj(s) && Object.keys(s).length)) req.auth = defaultAuth("none");
          // Set on the operation itself: with no global security, operations without their
          // own stay public instead of inheriting another operation's scheme.
          if (opAuth && JSON.stringify(opAuth.auth) !== JSON.stringify(c.auth)) {
            req.auth = opAuth.auth;
            addVars(opAuth.vars);
          }
        }
      }

      const tag = arr(op.tags).map(str)[0];
      if (tag) {
        let folder = folders.get(tag);
        if (!folder) {
          folder = newFolder({ name: tag, order: c.folders.length });
          const tagInfo = arr(doc.tags).filter(isObj).find((t) => str(t.name) === tag);
          if (tagInfo?.description) folder.description = str(tagInfo.description);
          folders.set(tag, folder);
          c.folders.push(folder);
        }
        req.order = folder.requests.length;
        folder.requests.push(req);
      } else {
        req.order = c.requests.length;
        c.requests.push(req);
      }
    }
  }
  const extra = [
    ...(base.relative ? ["The document gives its server relative to where it is hosted: set {{host}} (e.g. https://api.example.com) in an environment."] : []),
    ...[...notes].map((n) => `Security scheme ${n}`),
  ];
  if (extra.length) c.description = [c.description, "Import notes:", ...extra.map((n) => `- ${n}`)].filter(Boolean).join("\n\n");
  return c;
}

// ---------------------------------------------------------------------------
// HAR (HTTP Archive, e.g. "Save all as HAR" in browser devtools)

// Set by the client or the connection, not by the person making the request.
const HAR_SKIPPED_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding", "transfer-encoding", "keep-alive", "upgrade", "te"]);

function harBody(req: YamletRequest, postData: Obj, headers: KeyValue[]): void {
  const mime = str(postData.mimeType).toLowerCase() || (headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "");
  const params = arr(postData.params).filter(isObj);
  if (mime.startsWith("application/x-www-form-urlencoded")) {
    req.body.type = "urlencoded";
    req.body.fields = params.length
      ? params.map((p) => ({ key: str(p.name), value: str(p.value), enabled: true }))
      : splitRawUrl(`?${str(postData.text)}`).query;
  } else if (mime.startsWith("multipart/form-data") && params.length) {
    req.body.type = "form-data";
    // Uploaded files aren't in the archive; their names are kept so a file can be picked again.
    req.body.fields = params.map((p) => (p.fileName !== undefined ? { key: str(p.name), value: str(p.fileName), enabled: true, isFile: true } : { key: str(p.name), value: str(p.value), enabled: true }));
    // The archived Content-Type has the old boundary.
    req.headers = req.headers.filter((h) => h.key.toLowerCase() !== "content-type");
  } else if (postData.text !== undefined) {
    req.body.raw = str(postData.text);
    req.body.type = mime.includes("json") ? "json" : mime.includes("xml") ? "xml" : mime.includes("html") ? "html" : "text";
  }
}

/** One request per archived entry, in order, in a new collection. */
export function importHar(json: unknown, name = "HAR import"): YamletCollection {
  const doc = typeof json === "string" ? JSON.parse(json) : json;
  const entries = arr(asObj(asObj(doc).log).entries).filter(isObj);
  if (!entries.length) throw new Error("The HAR file has no entries");
  const c = newCollection({ name });
  entries.forEach((entry, i) => {
    const r = asObj(entry.request);
    const rawUrl = str(r.url);
    if (!rawUrl) return;
    const headers = arr(r.headers)
      .filter(isObj)
      .map((h) => ({ key: str(h.name), value: str(h.value), enabled: true }))
      .filter((h) => h.key && !h.key.startsWith(":") && !HAR_SKIPPED_HEADERS.has(h.key.toLowerCase()));
    const { base, query } = splitRawUrl(rawUrl);
    let path = base;
    try {
      path = new URL(base).pathname;
    } catch {
      /* keep the raw URL */
    }
    const method = (str(r.method) || "GET").toUpperCase();
    const req = newRequest({ name: `${method} ${path}`.slice(0, 120), method, url: base, headers, queryParams: query, order: i * 1000 });
    if (isObj(r.postData)) harBody(req, r.postData, headers);
    c.requests.push(req);
  });
  return c;
}

