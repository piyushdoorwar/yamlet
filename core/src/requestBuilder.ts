// Turns a YamletRequest into the concrete HTTP request that will be sent: variables
// resolved, query and path parameters applied, auth and default headers added.
// Isomorphic: shared by the executor and the UI's code snippets.
import { YAMLET_USER_AGENT, type Auth, type KeyValue, type YamletCollection, type YamletRequest } from "./models.js";
import { resolveVariables, type VariableContext } from "./variableResolver.js";

export type BuiltBody =
  | { kind: "none" }
  | { kind: "text"; text: string; contentType?: string }
  | { kind: "urlencoded"; fields: { key: string; value: string }[] }
  | { kind: "form-data"; fields: { key: string; value: string; isFile: boolean }[] }
  | { kind: "binary"; file: string; contentType?: string };

export interface BuiltRequest {
  method: string;
  /** Fully resolved URL including query params, `:path` variables and query-located auth. */
  url: string;
  /** Enabled, resolved headers including auth, Content-Type (except multipart) and User-Agent. */
  headers: KeyValue[];
  body: BuiltBody;
}

export interface BuildOptions {
  ctx: VariableContext;
  collection?: YamletCollection;
  /** An OAuth2 access token obtained by the caller; overrides the stored one. */
  oauthToken?: string;
}

const DEFAULT_CONTENT_TYPES: Record<string, string> = {
  raw: "text/plain",
  text: "text/plain",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  graphql: "application/json",
};

/** Request auth, or the collection's when the request inherits. */
export function effectiveAuth(request: YamletRequest, collection?: YamletCollection): Auth {
  if (request.auth?.type === "inherit") {
    return collection?.auth && collection.auth.type !== "inherit" ? collection.auth : { ...request.auth, type: "none" };
  }
  return request.auth;
}

export function encodeQueryComponent(s: string): string {
  return encodeURIComponent(s);
}

export function appendQuery(url: string, pairs: { key: string; value: string }[]): string {
  if (!pairs.length) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const query = pairs.map((p) => `${encodeQueryComponent(p.key)}=${encodeQueryComponent(p.value)}`).join("&");
  const sep = base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
  return base + sep + query + hash;
}

export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Replaces `:name` path segments with values. Only touches the path, never the host or port. */
export function applyPathVariables(url: string, vars: { key: string; value: string }[]): string {
  if (!vars.length) return url;
  const schemeEnd = url.indexOf("://");
  const pathStart = url.indexOf("/", schemeEnd >= 0 ? schemeEnd + 3 : 0);
  if (pathStart < 0) return url;
  const qAt = url.search(/[?#]/);
  const pathEnd = qAt >= 0 && qAt > pathStart ? qAt : url.length;
  let path = url.slice(pathStart, pathEnd);
  for (const v of vars) {
    if (!v.key) continue;
    const key = v.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    path = path.replace(new RegExp(`(?<=/):${key}(?=[/.;]|$)`, "g"), () => v.value);
  }
  return url.slice(0, pathStart) + path + url.slice(pathEnd);
}

function isFileField(f: { isFile?: boolean; value: string; description?: string }): boolean {
  return !!f.isFile || f.value.startsWith("@") || (f.description ?? "").trim().toLowerCase() === "file";
}

export function buildRequest(request: YamletRequest, opts: BuildOptions): BuiltRequest {
  const r = (s: string | undefined) => resolveVariables(s ?? "", opts.ctx);
  const method = (request.method || "GET").trim().toUpperCase();

  let url = r(request.url).trim();
  url = applyPathVariables(
    url,
    (request.pathVariables ?? []).map((p) => ({ key: p.key, value: r(p.value) })),
  );
  const query = (request.queryParams ?? [])
    .filter((p) => p.enabled !== false && p.key?.trim())
    .map((p) => ({ key: r(p.key), value: r(p.value) }));
  url = appendQuery(url, query);

  const headers: KeyValue[] = [{ key: "User-Agent", value: YAMLET_USER_AGENT, enabled: true }];
  for (const h of request.headers ?? []) {
    if (h.enabled === false || !h.key?.trim()) continue;
    const key = r(h.key).trim();
    if (key.toLowerCase() === "user-agent") continue; // the Yamlet agent is locked
    headers.push({ key, value: r(h.value), enabled: true });
  }
  const hasHeader = (name: string) => headers.some((h) => h.key.toLowerCase() === name.toLowerCase());

  // Auth
  const auth = effectiveAuth(request, opts.collection);
  switch (auth.type) {
    case "bearer": {
      const token = r(auth.token);
      if (token.trim()) headers.push({ key: "Authorization", value: `Bearer ${token}`, enabled: true });
      break;
    }
    case "basic": {
      const encoded = utf8ToBase64(`${r(auth.username)}:${r(auth.password)}`);
      headers.push({ key: "Authorization", value: `Basic ${encoded}`, enabled: true });
      break;
    }
    case "apikey": {
      const name = r(auth.apiKeyName).trim();
      if (!name) break;
      const value = r(auth.apiKeyValue);
      if (auth.apiKeyIn === "query") url = appendQuery(url, [{ key: name, value }]);
      else headers.push({ key: name, value, enabled: true });
      break;
    }
    case "cookie": {
      const cookie = r(auth.cookie);
      if (cookie.trim()) headers.push({ key: "Cookie", value: cookie, enabled: true });
      break;
    }
    case "oauth2": {
      const o = auth.oauth2;
      const token = opts.oauthToken?.trim() ? opts.oauthToken : r(o.accessToken);
      if (!token?.trim()) break;
      if (o.addTokenTo === "query") url = appendQuery(url, [{ key: "access_token", value: token }]);
      else {
        const prefix = o.headerPrefix?.trim() ? r(o.headerPrefix).trim() : "Bearer";
        headers.push({ key: "Authorization", value: prefix ? `${prefix} ${token}` : token, enabled: true });
      }
      break;
    }
    default:
      break;
  }

  // Body. GET/HEAD bodies are still honored when explicitly configured.
  const b = request.body;
  let body: BuiltBody = { kind: "none" };
  switch (b?.type) {
    case "raw":
    case "json":
    case "xml":
    case "text":
    case "html": {
      if (b.raw) body = { kind: "text", text: r(b.raw), contentType: DEFAULT_CONTENT_TYPES[b.type] };
      break;
    }
    case "graphql": {
      const query = r(b.graphqlQuery);
      const varsText = r(b.graphqlVariables).trim();
      let variables: unknown = undefined;
      if (varsText) {
        try {
          variables = JSON.parse(varsText);
        } catch {
          variables = undefined;
        }
      }
      const payload: Record<string, unknown> = { query };
      if (variables !== undefined) payload.variables = variables;
      body = { kind: "text", text: JSON.stringify(payload), contentType: "application/json" };
      break;
    }
    case "urlencoded": {
      body = {
        kind: "urlencoded",
        fields: (b.fields ?? []).filter((f) => f.enabled !== false && f.key?.trim()).map((f) => ({ key: r(f.key), value: r(f.value) })),
      };
      break;
    }
    case "form-data": {
      body = {
        kind: "form-data",
        fields: (b.fields ?? [])
          .filter((f) => f.enabled !== false && f.key?.trim())
          .map((f) => {
            const value = r(f.value);
            const file = isFileField({ ...f, value });
            return { key: r(f.key), value: file && value.startsWith("@") ? value.slice(1) : value, isFile: file };
          }),
      };
      break;
    }
    case "binary": {
      const file = r(b.binaryFile).trim();
      if (file) body = { kind: "binary", file: file.startsWith("@") ? file.slice(1) : file, contentType: "application/octet-stream" };
      break;
    }
    default:
      break;
  }

  if (!hasHeader("content-type")) {
    if ((body.kind === "text" || body.kind === "binary") && body.contentType) {
      headers.push({ key: "Content-Type", value: body.contentType, enabled: true });
    } else if (body.kind === "urlencoded") {
      headers.push({ key: "Content-Type", value: "application/x-www-form-urlencoded", enabled: true });
    }
  } else if (body.kind === "text" || body.kind === "binary") {
    body = { ...body, contentType: headers.find((h) => h.key.toLowerCase() === "content-type")!.value };
  }

  return { method, url, headers, body };
}

/** Serializes urlencoded fields the way browsers and curl do (`+` for spaces). */
export function encodeUrlEncodedBody(fields: { key: string; value: string }[]): string {
  return new URLSearchParams(fields.map((f) => [f.key, f.value])).toString();
}
