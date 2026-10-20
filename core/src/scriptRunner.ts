// Pre-request / post-response JavaScript with a compact `pm` API. Each script runs in a
// fresh node:vm context. node:vm is isolation for convenience, not a security boundary:
// scripts are trusted the same way the workspace files are.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import querystring from "node:querystring";
import url from "node:url";
import util, { inspect } from "node:util";
import vm from "node:vm";
import { Ajv } from "ajv";
import * as chai from "chai";
import CryptoJS from "crypto-js";
import _ from "lodash";
import moment from "moment";
import type { KeyValue, ScriptTestResult, Variable, YamletRequest, YamletResponse } from "./models.js";
import type { CookieJar } from "./cookieJar.js";
import { encodeMultipart } from "./multipart.js";
import { appendQuery, withScheme } from "./requestBuilder.js";
import { lookupVariable, mergedVariables, resolveVariables, type VariableContext } from "./variableResolver.js";
import { xml2jsShim, xmlToJson } from "./xmlToJson.js";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;

export type ScriptScope = "local" | "environment" | "collection" | "globals";

export interface ScriptVariablesInit {
  request?: Variable[];
  iterationData?: Record<string, unknown>;
  /** Live lists: scripts mutate them in place. Pass copies if the caller's must not change. */
  collection?: Variable[];
  environment?: Variable[];
  globals?: Variable[];
}

/** Variable scopes visible to scripts during one send, with mutation tracking. */
export class ScriptVariables {
  readonly request: Variable[];
  readonly iterationData?: Record<string, unknown>;
  readonly collection?: Variable[];
  readonly environment?: Variable[];
  readonly globals?: Variable[];
  /** pm.variables.set values: highest precedence, never persisted. */
  readonly local = new Map<string, Variable>();
  readonly dirty = new Set<ScriptScope>();

  constructor(init: ScriptVariablesInit = {}) {
    this.request = init.request ?? [];
    this.iterationData = init.iterationData;
    this.collection = init.collection;
    this.environment = init.environment;
    this.globals = init.globals;
  }

  toContext(): VariableContext {
    return {
      request: [...this.request, ...this.local.values()],
      iterationData: this.iterationData,
      collection: this.collection,
      environment: this.environment,
      globals: this.globals,
    };
  }

  private list(scope: ScriptScope): Variable[] | undefined {
    return scope === "environment" ? this.environment : scope === "collection" ? this.collection : scope === "globals" ? this.globals : undefined;
  }

  get(scope: ScriptScope, key: string): string | undefined {
    if (scope === "local") {
      const hit = lookupVariable(key, this.toContext());
      return hit && hit.scope !== "dynamic" ? hit.value : undefined;
    }
    const list = this.list(scope);
    const lk = key;
    if (!list) return this.local.get(lk)?.value; // scope not available: falls back to local
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].enabled !== false && list[i].key === lk) return list[i].value;
    }
    return undefined;
  }

  set(scope: ScriptScope, key: string, value: string): void {
    if (!key?.trim()) return;
    const list = this.list(scope);
    if (scope === "local" || !list) {
      this.local.set(key, { key, value, enabled: true });
      this.dirty.add("local");
      return;
    }
    const existing = list.find((v) => v.key === key);
    if (existing) {
      existing.value = value;
      existing.enabled = true;
    } else list.push({ key, value, enabled: true });
    this.dirty.add(scope);
  }

  unset(scope: ScriptScope, key: string): void {
    const list = this.list(scope);
    const lk = key;
    if (scope === "local" || !list) {
      if (this.local.delete(lk)) this.dirty.add("local");
      return;
    }
    const before = list.length;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].key === lk) list.splice(i, 1);
    if (list.length !== before) this.dirty.add(scope);
  }

  clear(scope: ScriptScope): void {
    const list = this.list(scope);
    if (scope === "local" || !list) {
      this.local.clear();
      return;
    }
    if (list.length) {
      list.splice(0, list.length);
      this.dirty.add(scope);
    }
  }

  toObject(scope: ScriptScope): Record<string, string> {
    if (scope === "local") return mergedVariables(this.toContext());
    const out: Record<string, string> = {};
    for (const v of this.list(scope) ?? []) if (v.enabled !== false && v.key) out[v.key] = v.value;
    return out;
  }

  /** Full new lists for each persisted scope a script changed. */
  changes(): { environment?: Variable[]; collectionVariables?: Variable[]; globals?: Variable[] } {
    const out: { environment?: Variable[]; collectionVariables?: Variable[]; globals?: Variable[] } = {};
    if (this.dirty.has("environment") && this.environment) out.environment = structuredClone(this.environment);
    if (this.dirty.has("collection") && this.collection) out.collectionVariables = structuredClone(this.collection);
    if (this.dirty.has("globals") && this.globals) out.globals = structuredClone(this.globals);
    return out;
  }
}

export interface SendRequestSpec {
  url: string;
  method: string;
  headers: KeyValue[];
  body?: string | Buffer;
}

export interface ScriptInfo {
  requestName?: string;
  requestId?: string;
  iteration?: number;
  iterationCount?: number;
  environmentName?: string;
}

export interface RunScriptOptions {
  script: string;
  phase: "pre" | "post";
  /** Working copy of the request; pre-request scripts mutate it. */
  request: YamletRequest;
  response?: YamletResponse;
  variables: ScriptVariables;
  /** Receives every pm.test result. */
  tests: ScriptTestResult[];
  /** Receives console output. */
  logs: string[];
  /** A failed pm.test throws (aborting the script) instead of only being recorded. */
  throwOnFailure?: boolean;
  timeoutMs?: number;
  info?: ScriptInfo;
  /** Backs pm.sendRequest; when absent pm.sendRequest rejects. */
  sendRequest?: (spec: SendRequestSpec) => Promise<YamletResponse>;
  /** Filled by pm.execution: skip the send, or pick the runner's next request. */
  execution?: ExecutionControl;
  /** The workspace cookie jar, for pm.cookies.jar(); absent when the request turns the jar off. */
  cookieJar?: CookieJar;
}

export interface ExecutionControl {
  skipRequest: boolean;
  /** A request name or id to run next; null ends the iteration; undefined continues in order. */
  nextRequest?: string | null;
}

// ---------------------------------------------------------------------------
// chai: response assertions (pm.response.to.have.status(200), .to.be.ok, ...)

const RESPONSE = Symbol.for("yamlet.scriptResponse");
type Branded = { [RESPONSE]?: YamletResponse };
let pluginInstalled = false;

function installResponsePlugin(): void {
  if (pluginInstalled) return;
  pluginInstalled = true;
  chai.use((c, utils) => {
    const A = c.Assertion;
    const resp = (a: object): YamletResponse | undefined => (utils.flag(a, "object") as Branded | undefined)?.[RESPONSE];
    const need = (a: object): YamletResponse => {
      const r = resp(a);
      if (!r) throw new Error("expected a response object");
      return r;
    };
    A.addMethod("status", function (this: Chai.AssertionStatic, expected: number | string) {
      const r = need(this);
      if (typeof expected === "number")
        this.assert(r.statusCode === expected, "expected response to have status code #{exp} but got #{act}", "expected response to not have status code #{act}", expected, r.statusCode);
      else
        this.assert(r.reasonPhrase === expected, "expected response to have status reason #{exp} but got #{act}", "expected response to not have status reason #{act}", expected, r.reasonPhrase);
    });
    A.addMethod("header", function (this: Chai.AssertionStatic, name: string, value?: string) {
      const r = need(this);
      const h = r.headers.find((x) => x.key.toLowerCase() === String(name).toLowerCase());
      if (value === undefined) this.assert(!!h, `expected response to have header ${name}`, `expected response to not have header ${name}`, name, undefined);
      else this.assert(h?.value === value, `expected response header ${name} to be #{exp} but got #{act}`, `expected response header ${name} to not be #{act}`, value, h?.value);
    });
    A.addMethod("body", function (this: Chai.AssertionStatic, expected?: unknown) {
      const r = need(this);
      if (expected === undefined) this.assert(r.body.length > 0, "expected response to have a body", "expected response to not have a body", undefined, undefined);
      else if (typeof expected === "string") this.assert(r.body === expected, "expected response body to equal #{exp}", "expected response body to not equal #{exp}", expected, r.body);
      else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(r.body);
        } catch {
          parsed = undefined;
        }
        this.assert(utils.eql(parsed, expected), "expected response JSON body to deeply equal #{exp}", "expected response JSON body to not deeply equal #{exp}", expected, parsed);
      }
    });
    A.addMethod("jsonBody", function (this: Chai.AssertionStatic, pathOrValue?: unknown, value?: unknown) {
      const r = need(this);
      let parsed: unknown;
      let ok = true;
      try {
        parsed = JSON.parse(r.body);
      } catch {
        ok = false;
      }
      if (pathOrValue === undefined) {
        this.assert(ok, "expected response to have a JSON body", "expected response to not have a JSON body", undefined, undefined);
        return;
      }
      if (typeof pathOrValue === "string") {
        // Dots and [index] steps, as in "items[0].id".
        const got = _.get(parsed, pathOrValue.replace(/^\$\.?/, ""));
        if (value === undefined) this.assert(got !== undefined, `expected response JSON to have path ${pathOrValue}`, `expected response JSON to not have path ${pathOrValue}`, undefined, undefined);
        else this.assert(utils.eql(got, value), `expected response JSON at ${pathOrValue} to deeply equal #{exp} but got #{act}`, `expected response JSON at ${pathOrValue} to not deeply equal #{exp}`, value, got);
        return;
      }
      this.assert(utils.eql(parsed, pathOrValue), "expected response JSON body to deeply equal #{exp}", "expected response JSON body to not deeply equal #{exp}", pathOrValue, parsed);
    });
    // pm.response.to.have.jsonSchema(schema), and expect(value).to.have.jsonSchema(schema).
    A.addMethod("jsonSchema", function (this: Chai.AssertionStatic, schema: object, options?: object) {
      const r = resp(this);
      let data: unknown = utils.flag(this, "object");
      if (r) {
        try {
          data = JSON.parse(r.body);
        } catch {
          this.assert(false, "expected response body to be JSON to check it against a schema", "", undefined, undefined);
          return;
        }
      }
      const ajv = new Ajv({ allErrors: true, strict: false, ...options });
      const validate = ajv.compile(schema);
      const valid = validate(data);
      this.assert(!!valid, `expected data to match the JSON schema: ${ajv.errorsText(validate.errors)}`, "expected data to not match the JSON schema", undefined, undefined);
    });
    // pm.response.to.have.responseTime(ms) checks the exact time; .responseTime.below(ms) and
    // friends compare against it.
    A.addChainableMethod(
      "responseTime",
      function (this: Chai.AssertionStatic, ms?: number) {
        if (ms === undefined) return;
        const took = utils.flag(this, "object") as number;
        this.assert(took === ms, "expected response time to be #{exp}ms but got #{act}ms", "expected response time to not be #{exp}ms", ms, took);
      },
      function (this: Chai.AssertionStatic) {
        utils.flag(this, "object", Math.round(need(this).durationMs));
      },
    );
    A.overwriteProperty("ok", (_super: () => void) =>
      function (this: Chai.AssertionStatic) {
        const r = resp(this);
        if (!r) return _super.call(this);
        this.assert(r.statusCode >= 200 && r.statusCode < 300, "expected response to be ok (2xx) but got #{act}", "expected response to not be ok but got #{act}", undefined, r.statusCode);
      },
    );
    const statusProps: [string, (s: number) => boolean, string][] = [
      ["success", (s) => s >= 200 && s < 300, "successful (2xx)"],
      ["info", (s) => s >= 100 && s < 200, "informational (1xx)"],
      ["redirection", (s) => s >= 300 && s < 400, "a redirection (3xx)"],
      ["clientError", (s) => s >= 400 && s < 500, "a client error (4xx)"],
      ["serverError", (s) => s >= 500, "a server error (5xx)"],
      ["error", (s) => s >= 400, "an error (4xx/5xx)"],
      ["accepted", (s) => s === 202, "accepted (202)"],
      ["badRequest", (s) => s === 400, "a bad request (400)"],
      ["unauthorized", (s) => s === 401, "unauthorized (401)"],
      ["forbidden", (s) => s === 403, "forbidden (403)"],
      ["notFound", (s) => s === 404, "not found (404)"],
      ["rateLimited", (s) => s === 429, "rate limited (429)"],
    ];
    for (const [name, test, label] of statusProps) {
      A.addProperty(name, function (this: Chai.AssertionStatic) {
        const r = need(this);
        this.assert(test(r.statusCode), `expected response to be ${label} but got #{act}`, `expected response to not be ${label}`, undefined, r.statusCode);
      });
    }
    A.addProperty("json", function (this: Chai.AssertionStatic) {
      const r = need(this);
      let ok = true;
      try {
        JSON.parse(r.body);
      } catch {
        ok = false;
      }
      this.assert(ok, "expected response body to be valid JSON", "expected response body to not be JSON", undefined, undefined);
    });
    A.addProperty("withBody", function (this: Chai.AssertionStatic) {
      const r = need(this);
      this.assert(r.body.length > 0, "expected response to have a body", "expected response to not have a body", undefined, undefined);
    });
  });
}

// ---------------------------------------------------------------------------
// Facades

const errMessage = (e: unknown): string =>
  e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);

function decodeBody(r: YamletResponse): string {
  return r.bodyEncoding === "base64" ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
}

function headerList(list: KeyValue[]) {
  const find = (name: string) => list.find((h) => h.key.toLowerCase() === String(name).toLowerCase());
  return {
    get: (name: string) => find(name)?.value,
    has: (name: string) => !!find(name),
    all: () => list.map((h) => ({ key: h.key, value: h.value })),
    toObject: () => Object.fromEntries(list.map((h) => [h.key, h.value])),
    each: (fn: (h: { key: string; value: string }) => void) => list.forEach((h) => fn({ key: h.key, value: h.value })),
    count: () => list.length,
    get members() {
      return list.map((h) => ({ key: h.key, value: h.value }));
    },
  };
}

type JarCallback<T> = ((err: Error | null, value?: T) => void) | undefined;

/** pm.cookies before a response: the jar's cookies for the request URL. */
function jarCookies(jar: CookieJar | undefined, url: string) {
  const list = () => jar?.cookiesFor(url) ?? [];
  return {
    get: (name: string) => list().find((c) => c.name === name)?.value,
    has: (name: string) => list().some((c) => c.name === name),
    toObject: () => Object.fromEntries(list().map((c) => [c.name, c.value])),
    all: () => list().map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
  };
}

/** pm.cookies.jar(): callback-style access to the workspace jar for a URL. */
function jarApi(jar: CookieJar | undefined) {
  const run = <T>(cb: JarCallback<T>, work: (j: CookieJar) => T) => {
    let err: Error | null = null;
    let value: T | undefined;
    try {
      if (!jar) throw new Error("The cookie jar is turned off for this request");
      value = work(jar);
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    if (typeof cb === "function") queueMicrotask(() => cb(err, value));
  };
  const host = (url: string) => {
    const u = new URL(withScheme(String(url)));
    return { domain: u.hostname.toLowerCase(), secure: u.protocol === "https:" };
  };
  return {
    getAll: (url: string, cb?: JarCallback<{ name: string; value: string }[]>) =>
      run(cb, (j) => j.cookiesFor(withScheme(String(url))).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }))),
    get: (url: string, name: string, cb?: JarCallback<string | undefined>) => run(cb, (j) => j.cookiesFor(withScheme(String(url))).find((c) => c.name === name)?.value),
    set: (url: string, nameOrCookie: string | { name: string; value?: string; path?: string; secure?: boolean; httpOnly?: boolean }, valueOrCb?: unknown, cb?: JarCallback<{ name: string; value: string }>) => {
      const cookie = typeof nameOrCookie === "string" ? { name: nameOrCookie, value: String(valueOrCb ?? "") } : nameOrCookie;
      const done = (typeof nameOrCookie === "string" ? cb : valueOrCb) as JarCallback<{ name: string; value: string }>;
      run(done, (j) => {
        const { domain, secure } = host(url);
        j.set({ name: cookie.name, value: cookie.value ?? "", domain, hostOnly: true, path: cookie.path ?? "/", secure: cookie.secure ?? secure, httpOnly: cookie.httpOnly ?? false });
        return { name: cookie.name, value: cookie.value ?? "" };
      });
    },
    unset: (url: string, name: string, cb?: JarCallback<void>) => run(cb, (j) => j.remove(host(url).domain, name)),
    clear: (url: string, cb?: JarCallback<void>) => run(cb, (j) => j.clear(host(url).domain)),
  };
}

/** A draft-04 schema in the form Ajv reads: `id`, `$id` and `$schema` dropped, boolean exclusive bounds made numeric. */
function fromDraft4(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(fromDraft4);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    // Ids are dropped too: one Ajv compiles the same schema on every call, and a repeated $id would clash.
    if ((k === "id" || k === "$id" || k === "$schema") && typeof v === "string") continue;
    out[k] = k === "enum" || k === "default" || k === "const" || k === "examples" ? v : fromDraft4(v);
  }
  for (const [flag, bound] of [["exclusiveMaximum", "maximum"], ["exclusiveMinimum", "minimum"]] as const) {
    if (typeof out[flag] !== "boolean") continue;
    if (out[flag] && typeof out[bound] === "number") {
      out[flag] = out[bound];
      delete out[bound];
    } else delete out[flag];
  }
  return out;
}

/** `require("tv4")`: its validate / validateResult / validateMultiple calls, checked by Ajv. */
function tv4Shim() {
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
  const check = (data: unknown, schema: unknown) => {
    const validate = ajv.compile(fromDraft4(schema && typeof schema === "object" ? schema : {}) as object);
    const valid = validate(data) as boolean;
    const errors = (validate.errors ?? []).map((e) => ({ message: `${e.instancePath || "data"} ${e.message ?? "is invalid"}`, dataPath: e.instancePath, schemaPath: e.schemaPath, params: e.params }));
    return { valid, errors };
  };
  const shim = {
    error: null as unknown,
    missing: [] as string[],
    validate(data: unknown, schema: unknown) {
      const r = check(data, schema);
      shim.error = r.errors[0] ?? null;
      return r.valid;
    },
    validateResult(data: unknown, schema: unknown) {
      const r = check(data, schema);
      return { valid: r.valid, error: r.errors[0] ?? null, missing: [] };
    },
    validateMultiple(data: unknown, schema: unknown) {
      const r = check(data, schema);
      return { valid: r.valid, errors: r.errors, missing: [] };
    },
  };
  return shim;
}

function responseFacade(r: YamletResponse) {
  const facade = {
    [RESPONSE]: r,
    code: r.statusCode,
    status: r.reasonPhrase,
    responseTime: r.durationMs,
    responseSize: r.sizeBytes,
    headers: headerList(r.headers),
    cookies: {
      get: (name: string) => r.cookies.find((c) => c.name === name)?.value,
      has: (name: string) => r.cookies.some((c) => c.name === name),
      toObject: () => Object.fromEntries(r.cookies.map((c) => [c.name, c.value])),
      all: () => r.cookies.map((c) => ({ ...c })),
    },
    text: () => decodeBody(r),
    json: () => JSON.parse(decodeBody(r) || "null"),
    reason: () => r.reasonPhrase,
    size: () => {
      const header = r.headers.reduce((n, h) => n + Buffer.byteLength(`${h.key}: ${h.value}\r\n`), 0);
      return { body: r.sizeBytes, header, total: r.sizeBytes + header };
    },
    get to() {
      return chai.expect(facade).to;
    },
  };
  return facade;
}

function splitUrl(url: string): { base: string; query: KeyValue[] } {
  const hashAt = url.indexOf("#");
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = noHash.indexOf("?");
  if (qAt < 0) return { base: url, query: [] };
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  const query = noHash
    .slice(qAt + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return { key: decode(eq >= 0 ? pair.slice(0, eq) : pair), value: eq >= 0 ? decode(pair.slice(eq + 1)) : "", enabled: true };
    });
  return { base: noHash.slice(0, qAt), query };
}

function requestFacade(req: YamletRequest) {
  const upsertHeader = (h: { key?: string; name?: string; value?: unknown } | string, value?: unknown) => {
    const key = typeof h === "string" ? h : String(h?.key ?? h?.name ?? "");
    const val = typeof h === "string" ? value : h?.value;
    if (!key.trim()) return;
    const existing = req.headers.find((x) => x.key.toLowerCase() === key.toLowerCase());
    const text = val === undefined || val === null ? "" : String(val);
    if (existing) {
      existing.value = text;
      existing.enabled = true;
    } else req.headers.push({ key, value: text, enabled: true });
  };
  const removeHeader = (name: string | { key: string }) => {
    const key = (typeof name === "string" ? name : name?.key ?? "").toLowerCase();
    req.headers = req.headers.filter((h) => h.key.toLowerCase() !== key);
  };
  const enabledHeaders = () => req.headers.filter((h) => h.enabled !== false);
  const queryApi = {
    add: (p: { key: string; value?: unknown }) => req.queryParams.push({ key: String(p.key), value: String(p.value ?? ""), enabled: true }),
    upsert: (p: { key: string; value?: unknown }) => {
      const hit = req.queryParams.find((q) => q.key === p.key);
      if (hit) {
        hit.value = String(p.value ?? "");
        hit.enabled = true;
      } else queryApi.add(p);
    },
    remove: (key: string) => {
      req.queryParams = req.queryParams.filter((q) => q.key !== key);
    },
    get: (key: string) => req.queryParams.find((q) => q.key === key && q.enabled !== false)?.value,
    has: (key: string) => req.queryParams.some((q) => q.key === key && q.enabled !== false),
    all: () => req.queryParams.filter((q) => q.enabled !== false).map((q) => ({ key: q.key, value: q.value })),
    toObject: () => Object.fromEntries(req.queryParams.filter((q) => q.enabled !== false).map((q) => [q.key, q.value])),
    each: (fn: (q: { key: string; value: string }) => void) => req.queryParams.filter((q) => q.enabled !== false).forEach((q) => fn({ key: q.key, value: q.value })),
    count: () => req.queryParams.filter((q) => q.enabled !== false).length,
  };
  /** Query or field entries given as a list, one object, or `a=1&b=2` text. */
  const entries = (input: unknown): { key: string; value: string }[] => {
    if (typeof input === "string") return splitUrl(`?${input.replace(/^\?/, "")}`).query.map((q) => ({ key: q.key, value: q.value }));
    const list = Array.isArray(input) ? input : input && typeof input === "object" ? [input] : [];
    return list.flatMap((p) => (p && typeof p === "object" && "key" in p ? [{ key: String(p.key), value: p.value === undefined || p.value === null ? "" : String(p.value) }] : []));
  };
  const keysOf = (input: unknown): Set<string> =>
    new Set((Array.isArray(input) ? input : [input]).map((k) => (k && typeof k === "object" ? String((k as { key?: unknown }).key ?? "") : String(k ?? ""))));
  const full = () => appendQuery(req.url, req.queryParams.filter((q) => q.enabled !== false && q.key), "typed");
  const setUrl = (value: unknown) => {
    const { base, query } = splitUrl(String(value ?? ""));
    req.url = base;
    if (query.length || String(value).includes("?")) req.queryParams = query;
  };
  const urlFacade = {
    toString: full,
    update: setUrl,
    getHost: () => {
      try {
        return new URL(full()).hostname;
      } catch {
        return req.url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0];
      }
    },
    getPath: () => req.url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "") || "/",
    getQueryString: () => full().split("?")[1] ?? "",
    getPathWithQuery: () => {
      const q = full().split("?")[1];
      return (req.url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "") || "/") + (q ? `?${q}` : "");
    },
    addQueryParams: (params: unknown) => {
      for (const p of entries(params)) req.queryParams.push({ ...p, enabled: true });
    },
    removeQueryParams: (keys: unknown) => {
      const drop = keysOf(keys);
      req.queryParams = req.queryParams.filter((q) => !drop.has(q.key));
    },
    query: queryApi,
  };
  /** pm.request.body.urlencoded / .formdata: the body's fields as a list (switching an empty body to that mode). */
  const fieldList = (mode: "urlencoded" | "form-data") => {
    const own = () => (req.body.type === mode ? req.body.fields.filter((f) => f.enabled !== false) : []);
    const take = () => {
      if (req.body.type !== mode) {
        req.body.type = mode;
        req.body.fields = [];
      }
      return req.body.fields;
    };
    const list = {
      add: (p: unknown) => {
        for (const e of entries(p)) take().push({ ...e, enabled: true });
      },
      upsert: (p: unknown) => {
        for (const e of entries(p)) {
          const hit = take().find((f) => f.key === e.key);
          if (hit) Object.assign(hit, { value: e.value, enabled: true });
          else take().push({ ...e, enabled: true });
        }
      },
      remove: (keys: unknown) => {
        const drop = keysOf(keys);
        if (req.body.type === mode) req.body.fields = req.body.fields.filter((f) => !drop.has(f.key));
      },
      clear: () => {
        if (req.body.type === mode) req.body.fields = [];
      },
      get: (key: string) => own().find((f) => f.key === key)?.value,
      has: (key: string) => own().some((f) => f.key === key),
      all: () => own().map((f) => ({ key: f.key, value: f.value })),
      toObject: () => Object.fromEntries(own().map((f) => [f.key, f.value])),
      each: (fn: (f: { key: string; value: string }) => void) => own().forEach((f) => fn({ key: f.key, value: f.value })),
      count: () => own().length,
    };
    return list;
  };
  const body = {
    get mode() {
      return req.body.type;
    },
    get raw() {
      return req.body.raw;
    },
    urlencoded: fieldList("urlencoded"),
    formdata: fieldList("form-data"),
    set raw(v: unknown) {
      req.body.raw = v === undefined || v === null ? "" : String(v);
    },
    update(v: unknown) {
      if (typeof v === "string") req.body.raw = v;
      else if (v && typeof v === "object") {
        const o = v as { mode?: string; raw?: unknown; urlencoded?: { key: string; value?: unknown }[]; formdata?: { key: string; value?: unknown }[] };
        if (o.mode === "raw" || o.raw !== undefined) {
          req.body.raw = String(o.raw ?? "");
          if (req.body.type === "none") req.body.type = "raw";
        }
        const fields = o.urlencoded ?? o.formdata;
        if (fields) {
          req.body.type = o.urlencoded ? "urlencoded" : "form-data";
          req.body.fields = fields.map((f) => ({ key: String(f.key), value: String(f.value ?? ""), enabled: true }));
        }
      }
    },
    toString: () => req.body.raw,
  };
  const headersApi = {
    add: upsertHeader,
    upsert: upsertHeader,
    remove: removeHeader,
    get: (name: string) => enabledHeaders().find((h) => h.key.toLowerCase() === String(name).toLowerCase())?.value,
    has: (name: string) => enabledHeaders().some((h) => h.key.toLowerCase() === String(name).toLowerCase()),
    all: () => enabledHeaders().map((h) => ({ key: h.key, value: h.value })),
    toObject: () => Object.fromEntries(enabledHeaders().map((h) => [h.key, h.value])),
    each: (fn: (h: { key: string; value: string }) => void) => enabledHeaders().forEach((h) => fn({ key: h.key, value: h.value })),
  };
  return {
    get id() {
      return req.id;
    },
    get name() {
      return req.name;
    },
    get url() {
      return urlFacade;
    },
    set url(v: unknown) {
      setUrl(v);
    },
    get method() {
      return req.method;
    },
    set method(v: unknown) {
      const m = String(v ?? "").trim();
      if (m) req.method = m.toUpperCase();
    },
    headers: headersApi,
    body,
    addHeader: upsertHeader,
    removeHeader,
  };
}

function scopeApi(vars: ScriptVariables, scope: ScriptScope, ctxForReplace: () => VariableContext, extra: object = {}) {
  const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return {
    get: (key: string) => vars.get(scope, String(key)),
    set: (key: string, value: unknown) => vars.set(scope, String(key), text(value)),
    unset: (key: string) => vars.unset(scope, String(key)),
    has: (key: string) => vars.get(scope, String(key)) !== undefined,
    clear: () => vars.clear(scope),
    toObject: () => vars.toObject(scope),
    replaceIn: (template: unknown) => resolveVariables(text(template), ctxForReplace()),
    ...extra,
  };
}

/** The spec as given; text is resolved later, except form parts, which are resolved here before encoding. */
function normalizeSendSpec(input: unknown, resolve: (s: string) => string): SendRequestSpec {
  if (typeof input === "string") return { url: input, method: "GET", headers: [] };
  const o = (input ?? {}) as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url : String((o.url as { toString?: () => string })?.toString?.() ?? "");
  const headers: KeyValue[] = [];
  const rawHeaders = o.header ?? o.headers;
  if (Array.isArray(rawHeaders)) {
    for (const h of rawHeaders) if (h && typeof h === "object") headers.push({ key: String(h.key ?? h.name ?? ""), value: String(h.value ?? ""), enabled: true });
    else if (typeof h === "string" && h.includes(":")) headers.push({ key: h.slice(0, h.indexOf(":")).trim(), value: h.slice(h.indexOf(":") + 1).trim(), enabled: true });
  } else if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) headers.push({ key: k, value: String(v), enabled: true });
  }
  let body: string | Buffer | undefined;
  const b = o.body;
  if (typeof b === "string") body = b;
  else if (b && typeof b === "object") {
    const bo = b as { mode?: string; raw?: unknown; urlencoded?: { key: string; value?: unknown }[]; formdata?: { key: string; value?: unknown; type?: string; contentType?: string; disabled?: boolean }[] };
    if (bo.mode === "formdata" && Array.isArray(bo.formdata)) {
      // Text parts only: a script has no file picker, and files would need the workspace.
      const parts = bo.formdata.filter((f) => !f.disabled && f.type !== "file").map((f) => ({ key: resolve(String(f.key)), value: resolve(String(f.value ?? "")), ...(f.contentType ? { contentType: String(f.contentType) } : {}) }));
      const encoded = encodeMultipart(parts);
      body = encoded.body;
      headers.splice(0, headers.length, ...headers.filter((h) => h.key.toLowerCase() !== "content-type"));
      headers.push({ key: "Content-Type", value: encoded.contentType, enabled: true });
    } else if (bo.mode === "urlencoded" && Array.isArray(bo.urlencoded)) {
      body = new URLSearchParams(bo.urlencoded.map((f) => [String(f.key), String(f.value ?? "")])).toString();
      if (!headers.some((h) => h.key.toLowerCase() === "content-type"))
        headers.push({ key: "Content-Type", value: "application/x-www-form-urlencoded", enabled: true });
    } else if (bo.raw !== undefined) body = typeof bo.raw === "string" ? bo.raw : JSON.stringify(bo.raw);
  }
  return { url, method: String(o.method ?? "GET").toUpperCase(), headers, body };
}

// ---------------------------------------------------------------------------
// Execution

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Runs one script. Throws on a script error (or a failed test with `throwOnFailure`). */
export async function runScript(opts: RunScriptOptions): Promise<void> {
  if (!opts.script?.trim()) return;
  installResponsePlugin();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const started = Date.now();
  const { variables: vars, tests, logs } = opts;
  const pending: Promise<unknown>[] = [];
  const asyncFailures: string[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const record = (name: string, passed: boolean, error?: string) => {
    const r: ScriptTestResult = { name, passed };
    if (!passed && error) r.error = error;
    tests.push(r);
  };

  const noted = new Set<string>();
  const noteOnce = (text: string) => {
    if (!noted.has(text)) logs.push(`[info] ${text}`);
    noted.add(text);
  };
  const fmt = (args: unknown[]) =>
    args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, breakLength: Infinity, compact: true }))).join(" ");
  const consoleApi = {
    log: (...a: unknown[]) => logs.push(fmt(a)),
    info: (...a: unknown[]) => logs.push(fmt(a)),
    debug: (...a: unknown[]) => logs.push(fmt(a)),
    trace: (...a: unknown[]) => logs.push(fmt(a)),
    warn: (...a: unknown[]) => logs.push("[warn] " + fmt(a)),
    error: (...a: unknown[]) => logs.push("[error] " + fmt(a)),
    clear: () => undefined,
  };

  const test = (name: unknown, fn?: unknown) => {
    const testName = String(name);
    if (typeof fn !== "function") return;
    try {
      let ret: unknown;
      if (fn.length > 0) {
        ret = new Promise<void>((resolve, reject) => {
          (fn as (done: (err?: unknown) => void) => void)((err?: unknown) => (err ? reject(err) : resolve()));
        });
      } else ret = (fn as () => unknown)();
      if (ret && typeof (ret as PromiseLike<unknown>).then === "function") {
        pending.push(
          Promise.resolve(ret as PromiseLike<unknown>).then(
            () => record(testName, true),
            (e) => {
              record(testName, false, errMessage(e));
              asyncFailures.push(`${testName}: ${errMessage(e)}`);
            },
          ),
        );
      } else record(testName, true);
    } catch (e) {
      record(testName, false, errMessage(e));
      if (opts.throwOnFailure) throw e;
    }
  };
  test.skip = (_name: unknown) => undefined;

  const ctxForReplace = () => vars.toContext();
  const iterationData = opts.variables.iterationData ?? {};
  const response = opts.response ? responseFacade(opts.response) : undefined;

  const sendRequest = (spec: unknown, cb?: (err: unknown, res: unknown) => void) => {
    const p = (async () => {
      if (!opts.sendRequest) throw new Error("pm.sendRequest is not available here");
      const resolve = (t: string) => resolveVariables(t, ctxForReplace());
      const s = normalizeSendSpec(spec, resolve);
      const res = await opts.sendRequest({
        url: resolve(s.url),
        method: s.method,
        headers: s.headers.map((h) => ({ ...h, key: resolve(h.key), value: resolve(h.value) })),
        body: typeof s.body === "string" ? resolve(s.body) : s.body,
      });
      if (res.isError) throw new Error(res.errorMessage ?? "Request failed");
      return responseFacade(res);
    })();
    const settled = p.then(
      (res) => {
        cb?.(null, res);
        return res;
      },
      (err) => {
        if (cb) cb(err, undefined);
        else throw err;
      },
    );
    pending.push(settled.catch(() => undefined));
    return settled;
  };

  const pm = {
    info: {
      eventName: opts.phase === "pre" ? "prerequest" : "test",
      requestName: opts.info?.requestName ?? opts.request.name,
      requestId: opts.info?.requestId ?? opts.request.id,
      iteration: opts.info?.iteration ?? 0,
      iterationCount: opts.info?.iterationCount ?? 1,
    },
    variables: scopeApi(vars, "local", ctxForReplace),
    environment: scopeApi(vars, "environment", ctxForReplace, { name: opts.info?.environmentName ?? "" }),
    collectionVariables: scopeApi(vars, "collection", ctxForReplace),
    globals: scopeApi(vars, "globals", ctxForReplace),
    iterationData: {
      get: (key: string) => iterationData[key],
      has: (key: string) => key in iterationData,
      toObject: () => ({ ...iterationData }),
      toJSON: () => ({ ...iterationData }),
    },
    replaceIn: (template: unknown) => resolveVariables(template == null ? "" : String(template), ctxForReplace()),
    request: requestFacade(opts.request),
    response,
    cookies: { ...(response?.cookies ?? jarCookies(opts.cookieJar, withScheme(resolveVariables(opts.request.url, ctxForReplace())))), jar: () => jarApi(opts.cookieJar) },
    test,
    expect: chai.expect,
    sendRequest,
    visualizer: {
      set: () => noteOnce("pm.visualizer isn't supported in Yamlet; the visualization was skipped."),
      clear: () => undefined,
    },
    execution: {
      /** In a pre-request script: don't send this request. */
      skipRequest: () => {
        if (opts.phase !== "pre") throw new Error("pm.execution.skipRequest() only works in a pre-request script");
        if (opts.execution) opts.execution.skipRequest = true;
      },
      /** In the collection runner: run this request (name or id) next, or null to stop. */
      setNextRequest: (next: unknown) => {
        if (opts.execution) opts.execution.nextRequest = next === null || next === undefined ? null : String(next);
      },
    },
  };

  const modules: Record<string, unknown> = {
    chai,
    uuid: { v4: randomUUID },
    lodash: _,
    "crypto-js": CryptoJS,
    ajv: Ajv,
    tv4: tv4Shim(),
    moment,
    xml2js: xml2jsShim(),
    atob: (s: string) => atob(s),
    btoa: (s: string) => btoa(s),
    buffer: { Buffer },
    url,
    querystring,
    path: path.posix,
    util,
    events: EventEmitter,
  };
  for (const name of ["buffer", "url", "querystring", "path", "util", "events"]) modules[`node:${name}`] = modules[name];

  // The legacy global script API (tests[...], responseBody, a global helper object) that imported
  // collections still use, mapped onto the pm API.
  const legacyTests: Record<string, unknown> = {};
  const legacy = {
    tests: legacyTests,
    xml2Json: (text: unknown) => xmlToJson(String(text ?? "")),
    data: { ...iterationData },
    iteration: opts.info?.iteration ?? 0,
    environment: vars.toObject("environment"),
    globals: vars.toObject("globals"),
    request: {
      id: pm.info.requestId,
      name: pm.info.requestName,
      url: resolveVariables(opts.request.url, ctxForReplace()),
      method: opts.request.method,
      headers: Object.fromEntries(opts.request.headers.filter((h) => h.enabled !== false && h.key).map((h) => [h.key, resolveVariables(h.value, ctxForReplace())])),
      data: opts.request.body.type === "form-data" || opts.request.body.type === "urlencoded" ? Object.fromEntries(opts.request.body.fields.filter((f) => f.enabled !== false && f.key).map((f) => [f.key, f.value])) : opts.request.body.raw,
    },
    ...(opts.response
      ? {
          responseBody: decodeBody(opts.response),
          responseCode: { code: opts.response.statusCode, name: opts.response.reasonPhrase, detail: opts.response.reasonPhrase },
          responseHeaders: Object.fromEntries(opts.response.headers.map((h) => [h.key, h.value])),
          responseTime: opts.response.durationMs,
          responseCookies: opts.response.cookies.map((c) => ({ ...c })),
        }
      : {}),
    postman: {
      setEnvironmentVariable: (k: string, v: unknown) => pm.environment.set(k, v),
      getEnvironmentVariable: (k: string) => pm.environment.get(k),
      clearEnvironmentVariable: (k: string) => pm.environment.unset(k),
      clearEnvironmentVariables: () => pm.environment.clear(),
      setGlobalVariable: (k: string, v: unknown) => pm.globals.set(k, v),
      getGlobalVariable: (k: string) => pm.globals.get(k),
      clearGlobalVariable: (k: string) => pm.globals.unset(k),
      clearGlobalVariables: () => pm.globals.clear(),
      getVariable: (k: string) => pm.variables.get(k),
      setNextRequest: (next: unknown) => pm.execution.setNextRequest(next),
      getResponseHeader: (name: string) => response?.headers.get(name),
      getResponseCookie: (name: string) => opts.response?.cookies.find((c) => c.name === name),
    },
  };
  const recordLegacyTests = () => {
    for (const [name, value] of Object.entries(legacyTests)) record(name, !!value, value ? undefined : "The test's expression was false");
  };
  const sandbox: Record<string, unknown> = {
    ...legacy,
    pm,
    console: consoleApi,
    atob,
    btoa,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    crypto: globalThis.crypto,
    Buffer,
    _,
    CryptoJS,
    setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const t = setTimeout(() => {
        timers.delete(t);
        try {
          fn(...args);
        } catch (e) {
          logs.push(`[error] ${errMessage(e)}`);
        }
      }, ms);
      timers.add(t);
      return t;
    },
    clearTimeout: (t: NodeJS.Timeout) => {
      timers.delete(t);
      clearTimeout(t);
    },
    require: (name: string) => {
      if (name in modules) return modules[name];
      throw new Error(`Module "${name}" is not available in Yamlet scripts`);
    },
  };

  const context = vm.createContext(sandbox, { name: `yamlet-${opts.phase}-script` });
  const script = new vm.Script(`(async () => {\n${opts.script}\n})()`, { filename: `${opts.phase === "pre" ? "pre-request" : "post-response"}.js` });
  try {
    const result = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
    const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
    await withDeadline(Promise.resolve(result), remaining(), "Script");
    // Wait for async tests, pm.sendRequest calls and timers the script started.
    while (pending.length || timers.size) {
      if (pending.length) {
        const batch = pending.splice(0, pending.length);
        await withDeadline(Promise.allSettled(batch), remaining(), "Script");
      } else await withDeadline(new Promise((r) => setTimeout(r, 5)), remaining(), "Script");
    }
  } finally {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    recordLegacyTests();
  }
  if (opts.throwOnFailure && asyncFailures.length) throw new Error(asyncFailures[0]);
}
