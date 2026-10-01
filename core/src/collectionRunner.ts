// Headless run engine: sends requests in tree order (depth-first, folders before
// requests), with iterations / data rows, capturing pm.test results. Variable changes
// made by scripts carry forward to later requests in the same run (not written to disk).
import type { Dispatcher } from "undici";
import type { CookieJar } from "./cookieJar.js";
import type { ScriptTestResult, Variable, YamletCollection, YamletEnvironment, YamletFolder, YamletRequest, YamletWorkspace } from "./models.js";
import { execute } from "./requestExecutor.js";
import type { WorkspaceStore } from "./workspaceStore.js";

export interface RunRequestResult {
  iteration: number;
  requestId: string;
  name: string;
  /** Folder chain names from the collection root to the request's folder. */
  path: string[];
  collectionId: string;
  collectionName: string;
  method: string;
  /** Resolved URL that was sent. */
  url: string;
  status: number;
  durationMs: number;
  sizeBytes: number;
  tests: ScriptTestResult[];
  passed: boolean;
  error?: string;
}

export interface RunSummary {
  results: RunRequestResult[];
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  iterations: number;
  assertions: { total: number; failed: number };
  /** Variable state at the end of the run (for callers that want to persist it). */
  variables: { environment?: Variable[]; globals: Variable[]; collections: Record<string, Variable[]> };
  /** True when the run stopped early (bail or abort). */
  stopped: boolean;
}

export interface RunOptions {
  workspace?: YamletWorkspace;
  store?: WorkspaceStore;
  workspaceRoot: string;
  collectionIds?: string[];
  folderId?: string;
  /** Explicit subset and order. */
  requestIds?: string[];
  environment?: YamletEnvironment;
  globals: Variable[];
  iterations?: number;
  /** One row per iteration; when given, the iteration count is the row count. */
  data?: Record<string, string>[];
  delayMs?: number;
  bail?: boolean;
  cookieJar?: CookieJar;
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
  defaultTimeoutMs?: number;
  onResult?: (r: RunRequestResult) => void;
}

interface PlannedRequest {
  request: YamletRequest;
  collection: YamletCollection;
  path: string[];
}

function walk(collection: YamletCollection, node: YamletCollection | YamletFolder, chain: string[], out: PlannedRequest[]): void {
  for (const f of node.folders) walk(collection, f, [...chain, f.name], out);
  for (const request of node.requests) out.push({ request, collection, path: chain });
}

function findFolderNode(node: YamletCollection | YamletFolder, id: string, chain: string[]): { folder: YamletFolder; chain: string[] } | undefined {
  for (const f of node.folders) {
    if (f.id === id) return { folder: f, chain: [...chain, f.name] };
    const hit = findFolderNode(f, id, [...chain, f.name]);
    if (hit) return hit;
  }
  return undefined;
}

/** Requests to run, in order. */
export function planRun(workspace: YamletWorkspace, opts: Pick<RunOptions, "collectionIds" | "folderId" | "requestIds">): PlannedRequest[] {
  const collections = [...workspace.collections]
    .sort((a, b) => a.order - b.order)
    .filter((c) => !opts.collectionIds?.length || opts.collectionIds.includes(c.id));
  const all: PlannedRequest[] = [];
  if (opts.folderId) {
    for (const c of collections) {
      const hit = findFolderNode(c, opts.folderId, []);
      if (hit) {
        walk(c, hit.folder, hit.chain, all);
        break;
      }
    }
  } else for (const c of collections) walk(c, c, [], all);
  if (!opts.requestIds?.length) return all;
  // Explicit subset: honor the given order; look outside the folder filter if needed.
  const everywhere: PlannedRequest[] = [];
  for (const c of collections) walk(c, c, [], everywhere);
  const byId = new Map(everywhere.map((p) => [p.request.id, p]));
  return opts.requestIds.map((id) => byId.get(id)).filter((p): p is PlannedRequest => !!p);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runCollection(opts: RunOptions): Promise<RunSummary> {
  const workspace = opts.workspace ?? opts.store?.workspace;
  if (!workspace) throw new Error("runCollection needs a workspace or a store");
  const started = Date.now();
  const plan = planRun(workspace, opts);
  const iterations = opts.data?.length ? opts.data.length : Math.max(1, Math.floor(opts.iterations ?? 1));

  // Working copies so script changes chain between requests without touching the caller's data.
  let environment = opts.environment ? structuredClone(opts.environment) : undefined;
  let globals = structuredClone(opts.globals ?? []);
  const collectionVars = new Map<string, Variable[]>();
  const collectionFor = (c: YamletCollection): YamletCollection => {
    if (!collectionVars.has(c.id)) collectionVars.set(c.id, structuredClone(c.variables ?? []));
    return { ...c, variables: collectionVars.get(c.id)! };
  };

  const results: RunRequestResult[] = [];
  let stopped = false;
  outer: for (let iteration = 0; iteration < iterations; iteration++) {
    for (const item of plan) {
      if (opts.signal?.aborted) {
        stopped = true;
        break outer;
      }
      if (results.length && opts.delayMs) await sleep(opts.delayMs, opts.signal);
      if (opts.signal?.aborted) {
        stopped = true;
        break outer;
      }
      const collection = collectionFor(item.collection);
      const { response, changes } = await execute({
        request: item.request,
        collection,
        environment,
        globals,
        workspaceRoot: opts.workspaceRoot,
        cookieJar: opts.cookieJar,
        iterationData: opts.data?.[iteration],
        dispatcher: opts.dispatcher,
        signal: opts.signal,
        defaultTimeoutMs: opts.defaultTimeoutMs,
        iteration,
        iterationCount: iterations,
      });
      if (changes.environment && environment) environment = { ...environment, variables: changes.environment };
      if (changes.globals) globals = changes.globals;
      if (changes.collectionVariables) collectionVars.set(item.collection.id, changes.collectionVariables);

      const transportError = response.isError;
      const statusOk = response.statusCode >= 200 && response.statusCode <= 399;
      const passed = !transportError && statusOk && response.testResults.every((t) => t.passed);
      const result: RunRequestResult = {
        iteration,
        requestId: item.request.id,
        name: item.request.name,
        path: item.path,
        collectionId: item.collection.id,
        collectionName: item.collection.name,
        method: response.method || item.request.method,
        url: response.resolvedUrl || item.request.url,
        status: response.statusCode,
        durationMs: response.durationMs,
        sizeBytes: response.sizeBytes,
        tests: response.testResults,
        passed,
      };
      if (transportError) result.error = response.errorMessage ?? "Request failed";
      else if (!statusOk) result.error = `Unexpected status ${response.statusCode}${response.reasonPhrase ? " " + response.reasonPhrase : ""}`;
      results.push(result);
      opts.onResult?.(result);
      if (opts.bail && !passed) {
        stopped = true;
        break outer;
      }
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  return {
    results,
    total: results.length,
    passed: results.length - failed,
    failed,
    durationMs: Date.now() - started,
    iterations,
    assertions: {
      total: results.reduce((n, r) => n + r.tests.length, 0),
      failed: results.reduce((n, r) => n + r.tests.filter((t) => !t.passed).length, 0),
    },
    variables: { environment: environment?.variables, globals, collections: Object.fromEntries(collectionVars) },
    stopped,
  };
}

// ---------------------------------------------------------------------------
// Data files

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Iteration rows from a CSV (header row + rows) or JSON (array of objects) data file. */
export function parseDataFile(text: string, filename: string): Record<string, string>[] {
  const body = text.replace(/^﻿/, "");
  const isJson = /\.json$/i.test(filename) || (!/\.csv$/i.test(filename) && /^\s*[[{]/.test(body));
  if (isJson) {
    const parsed: unknown = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Row ${i + 1} is not an object`);
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([k, v]) => [k, cell(v)]));
    });
  }
  const rows = parseCsv(body);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
