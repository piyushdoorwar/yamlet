// Exporters to the widely used collection v2.1 JSON format and environment JSON, the
// mirror of importers.ts, so a workspace's collections can be shared or moved. Isomorphic.
import type { Auth, KeyValue, ResponseExample, Variable, YamletCollection, YamletEnvironment, YamletFolder, YamletRequest } from "./models.js";
import { writeAuth } from "./yamlDtos.js";

type Obj = Record<string, unknown>;

const rows = (list: KeyValue[]) =>
  list.map((h) => ({ key: h.key, value: h.value, ...(h.enabled === false ? { disabled: true } : {}), ...(h.description ? { description: h.description } : {}) }));

/** v2.1 auth: `{ type, <type>: [{ key, value, type }] }`; inherit is left out so the parent applies. */
function v2Auth(a: Auth): Obj | undefined {
  if (a.type === "inherit") return undefined;
  if (a.type === "none") return { type: "noauth" };
  // The cookie scheme has no v2.1 twin; a Cookie header via API key means the same.
  if (a.type === "cookie") return v2Auth({ ...a, type: "apikey", apiKeyName: "Cookie", apiKeyValue: a.cookie, apiKeyIn: "header" });
  const creds = (writeAuth(a).credentials ?? {}) as Obj;
  const list = Object.entries(creds).map(([key, value]) => ({ key, value, type: "string" }));
  return { type: a.type, [a.type]: list };
}

function events(pre: string, post: string): Obj[] | undefined {
  const out: Obj[] = [];
  const add = (listen: string, script: string) => {
    if (script.trim()) out.push({ listen, script: { type: "text/javascript", exec: script.split("\n") } });
  };
  add("prerequest", pre);
  add("test", post);
  return out.length ? out : undefined;
}

function v2Url(r: YamletRequest): Obj {
  const query = r.queryParams.filter((q) => q.key || q.value);
  const enabled = query.filter((q) => q.enabled !== false);
  const raw = enabled.length ? `${r.url}${r.url.includes("?") ? "&" : "?"}${enabled.map((q) => (q.value === "" ? q.key : `${q.key}=${q.value}`)).join("&")}` : r.url;
  return {
    raw,
    ...(query.length ? { query: rows(query) } : {}),
    ...(r.pathVariables.length ? { variable: r.pathVariables.map((p) => ({ key: p.key, value: p.value, ...(p.description ? { description: p.description } : {}) })) } : {}),
  };
}

function v2Body(r: YamletRequest): Obj | undefined {
  const b = r.body;
  switch (b.type) {
    case "json":
    case "xml":
    case "html":
    case "text":
    case "raw":
      return { mode: "raw", raw: b.raw, ...(b.type !== "raw" ? { options: { raw: { language: b.type } } } : {}) };
    case "urlencoded":
      return { mode: "urlencoded", urlencoded: rows(b.fields) };
    case "form-data":
      return {
        mode: "formdata",
        formdata: b.fields.map((f) => ({
          key: f.key,
          ...(f.isFile ? { type: "file", src: f.value } : { type: "text", value: f.value }),
          ...(f.contentType ? { contentType: f.contentType } : {}),
          ...(f.enabled === false ? { disabled: true } : {}),
          ...(f.description ? { description: f.description } : {}),
        })),
      };
    case "graphql": {
      let variables: unknown = b.graphqlVariables;
      try {
        variables = b.graphqlVariables.trim() ? JSON.stringify(JSON.parse(b.graphqlVariables)) : "";
      } catch {
        /* keep the text as typed */
      }
      return { mode: "graphql", graphql: { query: b.graphqlQuery, variables } };
    }
    case "binary":
      return { mode: "file", file: { src: b.binaryFile } };
    default:
      return undefined;
  }
}

function v2Response(e: ResponseExample, original: Obj): Obj {
  return {
    name: e.name,
    originalRequest: original,
    code: e.status,
    header: rows(e.headers),
    body: e.body,
  };
}

function v2Request(r: YamletRequest): Obj {
  const auth = v2Auth(r.auth);
  const body = v2Body(r);
  const request: Obj = {
    method: r.method,
    header: rows(r.headers),
    ...(body ? { body } : {}),
    url: v2Url(r),
    ...(auth ? { auth } : {}),
    ...(r.description ? { description: r.description } : {}),
  };
  const ev = events(r.preRequestScript, r.postResponseScript);
  const s = r.settings;
  const behavior: Obj = {
    ...(s.followRedirects === false ? { followRedirects: false } : {}),
    ...(s.skipSslVerification ? { strictSSL: false } : {}),
    ...(s.maxRedirects !== undefined && s.maxRedirects !== 10 ? { maxRedirects: s.maxRedirects } : {}),
    ...(s.followOriginalMethod ? { followOriginalHttpMethod: true } : {}),
    ...(s.followAuthorizationHeader ? { followAuthorizationHeader: true } : {}),
    ...(s.disableCookieJar ? { disableCookies: true } : {}),
  };
  return {
    name: r.name,
    ...(ev ? { event: ev } : {}),
    ...(Object.keys(behavior).length ? { protocolProfileBehavior: behavior } : {}),
    request,
    response: r.examples.map((e) => v2Response(e, request)),
  };
}

function v2Folder(f: YamletFolder): Obj {
  const auth = f.auth ? v2Auth(f.auth) : undefined;
  const ev = events(f.preRequestScript ?? "", f.postResponseScript ?? "");
  return { name: f.name, ...(f.description ? { description: f.description } : {}), item: items(f), ...(auth ? { auth } : {}), ...(ev ? { event: ev } : {}) };
}

function items(node: { folders: YamletFolder[]; requests: YamletRequest[] }): Obj[] {
  // Folders and requests share one order in the tree.
  const all: { order: number; out: Obj }[] = [
    ...node.folders.map((f) => ({ order: f.order, out: v2Folder(f) })),
    ...node.requests.map((r) => ({ order: r.order, out: v2Request(r) })),
  ];
  return all.sort((a, b) => a.order - b.order).map((x) => x.out);
}

const vars = (list: Variable[]) =>
  list.map((v) => ({ key: v.key, value: v.value, type: v.secret ? "secret" : "default", ...(v.enabled === false ? { disabled: true } : {}) }));

/** A collection as v2.1 JSON. Local variable values are included only when `includeLocal`. */
export function exportCollectionV2(c: YamletCollection, opts: { includeLocal?: boolean } = {}): Obj {
  const auth = v2Auth(c.auth);
  const ev = events(c.preRequestScript, c.postResponseScript);
  return {
    info: { name: c.name, ...(c.description ? { description: c.description } : {}) },
    item: items(c),
    ...(auth ? { auth } : {}),
    ...(ev ? { event: ev } : {}),
    ...(c.variables.length ? { variable: vars(opts.includeLocal ? c.variables : c.variables.map((v) => (v.local ? { ...v, value: "" } : v))) } : {}),
  };
}

/** An environment as environment JSON. Local values are blanked unless `includeLocal`. */
export function exportEnvironmentJson(e: YamletEnvironment, opts: { includeLocal?: boolean } = {}): Obj {
  return {
    id: e.id,
    name: e.name,
    values: e.variables.map((v) => ({ key: v.key, value: v.local && !opts.includeLocal ? "" : v.value, type: v.secret ? "secret" : "default", enabled: v.enabled !== false })),
  };
}

/** A file name for an export: the item's name with characters file systems reject replaced. */
export function exportFileName(name: string, kind: "collection" | "environment"): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || kind;
  return `${safe}.${kind === "collection" ? "collection" : "environment"}.json`;
}
