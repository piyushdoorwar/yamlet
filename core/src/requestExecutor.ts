// Sends a request over HTTP: scripts, variable resolution, auth (incl. OAuth2 token
// fetch), cookies, redirects, timeouts. Never throws; failures become error responses.
import { existsSync, promises as fs } from "node:fs";
import { STATUS_CODES } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Agent, FormData, request, type Dispatcher } from "undici";
import { CookieJar, parseSetCookie } from "./cookieJar.js";
import { defaultSettings, YAMLET_USER_AGENT, type KeyValue, type ResponseCookie, type ScriptTestResult, type Variable, type YamletCollection, type YamletEnvironment, type YamletRequest, type YamletResponse } from "./models.js";
import { canFetchAutomatically, getCachedToken } from "./oauth2.js";
import { buildRequest, effectiveAuth, encodeUrlEncodedBody, type BuiltRequest } from "./requestBuilder.js";
import { runScript, ScriptVariables, type SendRequestSpec } from "./scriptRunner.js";
import { resolveVariables } from "./variableResolver.js";

export interface ExecuteInput {
  request: YamletRequest;
  collection?: YamletCollection;
  environment?: YamletEnvironment;
  globals: Variable[];
  /** Relative file paths in form-data / binary bodies resolve against this. */
  workspaceRoot: string;
  cookieJar?: CookieJar;
  iterationData?: Record<string, string>;
  /** Used when the request's own timeout is 0. 0 or absent means no timeout. */
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
  dispatcher?: Dispatcher;
  /** When true a failed pm.test throws like the old app path; default false. */
  throwOnTestFailure?: boolean;
  /** Runner context exposed to scripts as pm.info. */
  iteration?: number;
  iterationCount?: number;
}

export interface ExecuteResult {
  response: YamletResponse;
  /** Full new variable lists for scopes that scripts changed. */
  changes: { environment?: Variable[]; collectionVariables?: Variable[]; globals?: Variable[] };
}

export const MAX_REDIRECTS = 10;

let insecure: Agent | undefined;
const insecureAgent = () => (insecure ??= new Agent({ connect: { rejectUnauthorized: false } }));

const errMessage = (e: unknown): string => {
  if (e && typeof e === "object") {
    const err = e as { message?: unknown; cause?: { code?: unknown; message?: unknown }; code?: unknown };
    const base = String(err.message ?? e);
    const cause = err.cause?.code ?? err.cause?.message;
    return cause && !base.includes(String(cause)) ? `${base} (${cause})` : base;
  }
  return String(e);
};

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : v;
}

function toHeaderList(headers: Record<string, string | string[] | undefined>): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [key, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    for (const value of Array.isArray(v) ? v : [v]) out.push({ key, value, enabled: true });
  }
  return out;
}

function toUndiciHeaders(list: KeyValue[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const h of list) {
    const k = h.key.toLowerCase();
    const prev = out[k];
    out[k] = prev === undefined ? h.value : Array.isArray(prev) ? [...prev, h.value] : [prev, h.value];
  }
  return out;
}

const TEXTUAL = /^text\/|json|xml|javascript|ecmascript|yaml|csv|x-www-form-urlencoded|graphql|html/i;

function isTextual(contentType: string, bytes: Buffer): boolean {
  if (contentType) return TEXTUAL.test(contentType);
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodeText(bytes: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function resolveFile(p: string, workspaceRoot: string, requestFile?: string): string {
  if (path.isAbsolute(p)) return p;
  const fromRoot = path.resolve(workspaceRoot, p);
  if (existsSync(fromRoot) || !requestFile) return fromRoot;
  const fromRequest = path.resolve(path.dirname(requestFile), p);
  return existsSync(fromRequest) ? fromRequest : fromRoot;
}

interface PreparedBody {
  body?: string | Buffer | FormData;
  display?: string;
}

async function prepareBody(built: BuiltRequest, workspaceRoot: string, requestFile?: string): Promise<PreparedBody> {
  const b = built.body;
  switch (b.kind) {
    case "text":
      return { body: b.text, display: b.text };
    case "urlencoded": {
      const text = encodeUrlEncodedBody(b.fields);
      return { body: text, display: text };
    }
    case "form-data": {
      const form = new FormData();
      const lines: string[] = [];
      for (const f of b.fields) {
        if (f.isFile) {
          const file = resolveFile(f.value, workspaceRoot, requestFile);
          const data = await fs.readFile(file);
          form.append(f.key, new Blob([data]), path.basename(file));
          lines.push(`${f.key}: [file ${f.value}, ${data.length} bytes]`);
        } else {
          form.append(f.key, f.value);
          lines.push(`${f.key}: ${f.value}`);
        }
      }
      return { body: form, display: `[multipart form-data]\n${lines.join("\n")}` };
    }
    case "binary": {
      const file = resolveFile(b.file, workspaceRoot, requestFile);
      const data = await fs.readFile(file);
      return { body: data, display: `[binary file ${b.file}, ${data.length} bytes]` };
    }
    default:
      return {};
  }
}

interface HttpExchange {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: Buffer;
  sentHeaders: KeyValue[];
  firstByteMs: number;
  totalMs: number;
}

/** One HTTP exchange including redirects (cookies are stored and re-sent on every hop). */
async function exchange(opts: {
  url: string;
  method: string;
  headers: KeyValue[];
  body?: string | Buffer | FormData;
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
  followRedirects: boolean;
  jar?: CookieJar;
}): Promise<HttpExchange> {
  let { url, method, body } = opts;
  let headers = opts.headers.filter((h) => !(body instanceof FormData && h.key.toLowerCase() === "content-type" && !/boundary=/i.test(h.value)));
  let explicitCookie = headers.find((h) => h.key.toLowerCase() === "cookie")?.value;
  const start = performance.now();
  for (let hop = 0; ; hop++) {
    const sent = headers.filter((h) => h.key.toLowerCase() !== "cookie");
    const fromJar = opts.jar?.cookieHeaderFor(url);
    const cookie = [explicitCookie, fromJar].filter(Boolean).join("; ");
    if (cookie) sent.push({ key: "Cookie", value: cookie, enabled: true });
    new URL(url); // throws a readable "Invalid URL" before touching the network
    const res = await request(url, {
      method: method as Dispatcher.HttpMethod,
      headers: toUndiciHeaders(sent),
      body,
      dispatcher: opts.dispatcher,
      signal: opts.signal,
    });
    const firstByteMs = performance.now() - start;
    const setCookie = res.headers["set-cookie"];
    if (opts.jar && setCookie) opts.jar.setFromResponse(url, Array.isArray(setCookie) ? setCookie : [setCookie]);
    const location = headerValue(res.headers, "location");
    if (opts.followRedirects && location && [301, 302, 303, 307, 308].includes(res.statusCode) && hop < MAX_REDIRECTS) {
      await res.body.dump();
      const next = new URL(location, url);
      if (next.host !== new URL(url).host) {
        // Credentials set for one host are not forwarded to another.
        headers = headers.filter((h) => !["authorization", "cookie"].includes(h.key.toLowerCase()));
        explicitCookie = undefined;
      }
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) {
        if (method !== "HEAD") method = "GET";
        body = undefined;
        headers = headers.filter((h) => !["content-type", "content-length"].includes(h.key.toLowerCase()));
      }
      url = next.toString();
      continue;
    }
    const bytes = Buffer.from(await res.body.arrayBuffer());
    return { status: res.statusCode, headers: res.headers, bytes, sentHeaders: sent, firstByteMs, totalMs: performance.now() - start };
  }
}

function cookiesOf(url: string, headers: Record<string, string | string[] | undefined>): ResponseCookie[] {
  const raw = headers["set-cookie"];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  return list.map((h) => parseSetCookie(h)).filter((c): c is ResponseCookie => !!c).map((c) => ({ ...c, domain: c.domain ?? host }));
}

function formatHeaders(list: KeyValue[]): string {
  return list.length ? list.map((h) => `  ${h.key}: ${h.value}`).join("\n") : "  [none]";
}

function consoleText(r: YamletResponse): string {
  const lines = [`${r.method} ${r.resolvedUrl}`, "", "Request Headers", formatHeaders(r.requestHeaders), "", "Request Body", r.requestBody || "[empty]", "", "Response"];
  if (r.isError) lines.push(`Error: ${r.errorMessage ?? "Request failed."}`);
  else {
    lines.push(`HTTP ${r.statusCode} ${r.reasonPhrase}`, "Response Headers", formatHeaders(r.headers), "", "Response Body");
    lines.push(r.bodyEncoding === "base64" ? `[binary body, ${r.sizeBytes} bytes]` : r.body || "[empty]");
  }
  return lines.join("\n");
}

function emptyResponse(method: string, url: string): YamletResponse {
  return {
    statusCode: 0,
    reasonPhrase: "",
    durationMs: 0,
    sizeBytes: 0,
    resolvedUrl: url,
    method,
    requestHeaders: [],
    headers: [],
    cookies: [],
    body: "",
    bodyEncoding: "utf8",
    contentType: "",
    timings: { total: 0 },
    testResults: [],
    scriptLogs: [],
    consoleText: "",
    isError: false,
  };
}

function errorResponse(base: YamletResponse, message: string): YamletResponse {
  const r = { ...base, isError: true, errorMessage: message };
  r.consoleText = consoleText(r);
  return r;
}

/** pm.sendRequest backend: a plain exchange, no scripts. */
async function scriptSend(spec: SendRequestSpec, input: ExecuteInput, dispatcher: Dispatcher | undefined): Promise<YamletResponse> {
  const base = emptyResponse(spec.method, spec.url);
  try {
    const headers = spec.headers.some((h) => h.key.toLowerCase() === "user-agent")
      ? spec.headers
      : [{ key: "User-Agent", value: YAMLET_USER_AGENT, enabled: true }, ...spec.headers];
    const ex = await exchange({ url: spec.url, method: spec.method, headers, body: spec.body, dispatcher, signal: input.signal, followRedirects: true, jar: input.cookieJar });
    const contentType = headerValue(ex.headers, "content-type") ?? "";
    const textual = isTextual(contentType, ex.bytes);
    return {
      ...base,
      statusCode: ex.status,
      reasonPhrase: STATUS_CODES[ex.status] ?? "",
      durationMs: Math.round(ex.totalMs),
      sizeBytes: ex.bytes.length,
      requestHeaders: ex.sentHeaders,
      requestBody: spec.body,
      headers: toHeaderList(ex.headers),
      cookies: cookiesOf(spec.url, ex.headers),
      body: textual ? decodeText(ex.bytes, contentType) : ex.bytes.toString("base64"),
      bodyEncoding: textual ? "utf8" : "base64",
      contentType,
      timings: { total: Math.round(ex.totalMs), firstByte: Math.round(ex.firstByteMs) },
    };
  } catch (e) {
    return errorResponse(base, errMessage(e));
  }
}

export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
  const req: YamletRequest = structuredClone(input.request);
  const collection = input.collection;
  const vars = new ScriptVariables({
    request: req.variables ?? [],
    iterationData: input.iterationData,
    collection: collection ? structuredClone(collection.variables ?? []) : undefined,
    environment: input.environment ? structuredClone(input.environment.variables ?? []) : undefined,
    globals: structuredClone(input.globals ?? []),
  });
  const tests: ScriptTestResult[] = [];
  const logs: string[] = [];
  const settings = { ...defaultSettings(), ...req.settings };
  const dispatcher = input.dispatcher ?? (settings.skipSslVerification ? insecureAgent() : undefined);
  const scriptBase = {
    request: req,
    variables: vars,
    tests,
    logs,
    info: {
      requestName: req.name,
      requestId: req.id,
      environmentName: input.environment?.name,
      iteration: input.iteration,
      iterationCount: input.iterationCount,
    },
    sendRequest: (spec: SendRequestSpec) => scriptSend(spec, input, dispatcher),
  };
  const finish = (response: YamletResponse): ExecuteResult => {
    const r = { ...response, testResults: tests, scriptLogs: logs };
    r.consoleText = consoleText(r);
    return { response: r, changes: vars.changes() };
  };

  // 1. Pre-request scripts: collection first (errors logged, never fatal), then the request's.
  if (collection?.preRequestScript?.trim()) {
    try {
      await runScript({ ...scriptBase, script: collection.preRequestScript, phase: "pre" });
    } catch (e) {
      logs.push(`[error] Collection pre-request script: ${errMessage(e)}`);
    }
  }
  if (req.preRequestScript?.trim()) {
    try {
      await runScript({ ...scriptBase, script: req.preRequestScript, phase: "pre", throwOnFailure: input.throwOnTestFailure });
    } catch (e) {
      return finish(errorResponse(emptyResponse(req.method, req.url), `Pre-request script error: ${errMessage(e)}`));
    }
  }

  // 2. Resolve (after scripts, so their mutations apply) and fetch an OAuth2 token if needed.
  const ctx = vars.toContext();
  const resolve = (s: string) => resolveVariables(s ?? "", ctx);
  const auth = effectiveAuth(req, collection);
  let oauthToken: string | undefined;
  if (auth.type === "oauth2" && canFetchAutomatically(auth.oauth2, resolve)) {
    try {
      oauthToken = (await getCachedToken(auth.oauth2, resolve, { dispatcher, signal: input.signal })).accessToken;
    } catch (e) {
      return finish(errorResponse(emptyResponse(req.method, resolve(req.url)), `OAuth 2.0 token request failed: ${errMessage(e)}`));
    }
  }
  const built = buildRequest(req, { ctx, collection, oauthToken });
  let response = emptyResponse(built.method, built.url);
  response.requestHeaders = built.headers;

  // 3. Send.
  const timeoutMs = settings.timeoutMs > 0 ? settings.timeoutMs : input.defaultTimeoutMs ?? 0;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const signals = [input.signal, timeoutSignal].filter((s): s is AbortSignal => !!s);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  try {
    const prepared = await prepareBody(built, input.workspaceRoot, req.sourceFilePath);
    response.requestBody = prepared.display;
    const ex = await exchange({
      url: built.url,
      method: built.method,
      headers: built.headers,
      body: prepared.body,
      dispatcher,
      signal,
      followRedirects: settings.followRedirects !== false,
      jar: input.cookieJar,
    });
    const contentType = headerValue(ex.headers, "content-type") ?? "";
    const textual = isTextual(contentType, ex.bytes);
    response = {
      ...response,
      statusCode: ex.status,
      reasonPhrase: STATUS_CODES[ex.status] ?? "",
      durationMs: Math.round(ex.totalMs),
      sizeBytes: ex.bytes.length,
      requestHeaders: ex.sentHeaders,
      headers: toHeaderList(ex.headers),
      cookies: cookiesOf(built.url, ex.headers),
      body: textual ? decodeText(ex.bytes, contentType) : ex.bytes.toString("base64"),
      bodyEncoding: textual ? "utf8" : "base64",
      contentType,
      timings: { total: Math.round(ex.totalMs), firstByte: Math.round(ex.firstByteMs), download: Math.max(0, Math.round(ex.totalMs - ex.firstByteMs)) },
    };
  } catch (e) {
    const message = input.signal?.aborted
      ? "Request was cancelled."
      : timeoutSignal?.aborted
        ? `Request timed out after ${timeoutMs} ms`
        : errMessage(e);
    return finish(errorResponse(response, message));
  }

  // 4. Post-response scripts: the request's, then the collection's (errors logged).
  if (req.postResponseScript?.trim()) {
    const before = tests.length;
    try {
      await runScript({ ...scriptBase, script: req.postResponseScript, phase: "post", response, throwOnFailure: input.throwOnTestFailure });
    } catch (e) {
      const message = errMessage(e);
      const last = tests.at(-1);
      // A thrown failed assertion is already recorded as a failed test.
      if (!(tests.length > before && last && !last.passed && last.error === message)) {
        tests.push({ name: "Post-response script", passed: false, error: message });
      }
      logs.push(`[error] Post-response script: ${message}`);
    }
  }
  if (collection?.postResponseScript?.trim()) {
    try {
      await runScript({ ...scriptBase, script: collection.postResponseScript, phase: "post", response });
    } catch (e) {
      logs.push(`[error] Collection post-response script: ${errMessage(e)}`);
    }
  }
  return finish(response);
}
