// yamlet: run Yamlet workspaces headlessly (for CI). bin.ts is the entry point.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseDataFile, runCollection, type RunRequestResult, type RunSummary } from "../../core/src/collectionRunner.js";
import { CookieJar } from "../../core/src/cookieJar.js";
import { defaultNetworkSettings, newEnvironment, setYamletVersion, type Variable, type YamletEnvironment, type YamletFolder, type YamletWorkspace } from "../../core/src/models.js";
import { WorkspaceStore } from "../../core/src/workspaceStore.js";
import { formatJson, formatJunit } from "../../core/src/runReports.js";
import { environmentFromYaml, globalsFromYaml } from "../../core/src/yamlDtos.js";

export { formatJson, formatJunit };

declare const __YAMLET_VERSION__: string;
const VERSION = typeof __YAMLET_VERSION__ === "string" ? __YAMLET_VERSION__ : "0.0.0-dev";
setYamletVersion(VERSION);

class CliError extends Error {}

export interface RunArgs {
  workspace: string;
  env?: string;
  globals?: string;
  collections: string[];
  iterations?: number;
  data?: string;
  delayMs: number;
  bail: boolean;
  reporter: "table" | "json" | "junit";
  out?: string;
  color: boolean;
  folder?: string;
  timeoutMs?: number;
  insecure: boolean;
  envVars: [string, string][];
  globalVars: [string, string][];
  caFiles: string[];
}

const USAGE = `Yamlet CLI: run Yamlet API collections headlessly.

Usage:
  yamlet run <workspace> [options]

Arguments:
  <workspace>               A Yamlet workspace folder (contains collections/ and
                            environments/), or its parent.

Options:
  -e, --env <name|file>     Environment to use: a name from the workspace, or a
                            path to an environment YAML file.
  -g, --globals <file>      Use these globals instead of the workspace's.
  -c, --collection <name>   Only run this collection (repeatable).
  -f, --folder <name>       Only run this folder (inside the chosen collections).
  -n, --iterations <n>      Run everything n times (default 1).
  -d, --data <file>         CSV or JSON data file; one iteration per row.
      --delay <ms>          Wait between requests.
      --bail                Stop after the first failing request.
      --env-var <key=value> Set an environment variable (repeatable).
      --global-var <key=value>
                            Set a global variable (repeatable).
      --timeout <ms>        Abandon a request after this long (default: none).
  -k, --insecure            Don't verify SSL certificates.
      --ca <file>           Also trust this CA certificate (PEM; repeatable).
  -r, --reporter <name>     table (default), json, or junit.
  -o, --out <file>          Write the json/junit report to a file instead of stdout.
      --no-color            Disable ANSI colors (also honors NO_COLOR).
  -h, --help                Show this help.
  -v, --version             Show the version.

HTTP_PROXY, HTTPS_PROXY and NO_PROXY are honored.

A request fails on a network error or a failed pm.test assertion. One without
tests also fails on a status outside 2xx/3xx. The exit code is 1 if anything
failed, else 0.

Example:
  yamlet run ./my-workspace --env dev --reporter junit --out results.xml`;

export function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = { workspace: "", collections: [], delayMs: 0, bail: false, reporter: "table", color: !process.env.NO_COLOR, insecure: false, envVars: [], globalVars: [], caFiles: [] };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) throw new CliError(`Option '${flag}' requires a value.`);
    return v;
  };
  const int = (raw: string, flag: string, min: number) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new CliError(`Option '${flag}' needs a whole number of at least ${min}.`);
    return n;
  };
  const pair = (raw: string, flag: string): [string, string] => {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new CliError(`Option '${flag}' needs key=value.`);
    return [raw.slice(0, eq), raw.slice(eq + 1)];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-f":
      case "--folder":
        args.folder = value(i++, a);
        break;
      case "--timeout":
        args.timeoutMs = int(value(i++, a), a, 0);
        break;
      case "-k":
      case "--insecure":
        args.insecure = true;
        break;
      case "--env-var":
        args.envVars.push(pair(value(i++, a), a));
        break;
      case "--global-var":
        args.globalVars.push(pair(value(i++, a), a));
        break;
      case "--ca":
        args.caFiles.push(value(i++, a));
        break;
      case "-e":
      case "--env":
        args.env = value(i++, a);
        break;
      case "-g":
      case "--globals":
        args.globals = value(i++, a);
        break;
      case "-c":
      case "--collection":
        args.collections.push(value(i++, a));
        break;
      case "-n":
      case "--iterations":
        args.iterations = int(value(i++, a), a, 1);
        break;
      case "-d":
      case "--data":
        args.data = value(i++, a);
        break;
      case "--delay":
        args.delayMs = int(value(i++, a), a, 0);
        break;
      case "--bail":
        args.bail = true;
        break;
      case "-r":
      case "--reporter": {
        const r = value(i++, a);
        if (r !== "table" && r !== "json" && r !== "junit") throw new CliError(`Unknown reporter '${r}'. Use table, json or junit.`);
        args.reporter = r;
        break;
      }
      case "-o":
      case "--out":
        args.out = value(i++, a);
        break;
      case "--no-color":
        args.color = false;
        break;
      default:
        if (a.startsWith("-")) throw new CliError(`Unknown option '${a}'.`);
        if (args.workspace) throw new CliError(`Unexpected argument '${a}'.`);
        args.workspace = a;
    }
  }
  if (!args.workspace) throw new CliError("Missing <workspace> path. Usage: yamlet run <workspace> [--env <name>]");
  return args;
}

function resolveEnvironment(ws: YamletWorkspace, arg: string | undefined): YamletEnvironment | undefined {
  if (!arg) return undefined;
  const path = resolve(arg);
  if (existsSync(path) && statSync(path).isFile()) return environmentFromYaml(readFileSync(path, "utf8"), path);
  const stem = basename(arg).replace(/\.(environment\.)?ya?ml$/i, "");
  const match = ws.environments.find((e) => e.name.toLowerCase() === arg.toLowerCase() || e.name.toLowerCase() === stem.toLowerCase());
  if (!match) {
    const names = ws.environments.map((e) => e.name).join(", ") || "none";
    throw new CliError(`Environment '${arg}' not found (no such file, and the workspace has: ${names}).`);
  }
  return match;
}

// ---- reporting ------------------------------------------------------------

const SGR = { green: "32", red: "31", cyan: "36", dim: "2", bold: "1" } as const;
type Tone = keyof typeof SGR;

function paint(text: string, color: boolean, ...tones: (Tone | undefined)[]): string {
  const codes = tones.filter((t): t is Tone => !!t).map((t) => SGR[t]);
  return color && codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

interface Cell {
  text: string;
  tone?: Tone;
}

function table(headers: string[], right: boolean[], rows: Cell[][], color: boolean, out: string[]): void {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].text.length)));
  const rule = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const line = (cells: Cell[], bold = false) =>
    "│" + cells.map((cell, c) => ` ${paint(right[c] ? cell.text.padStart(widths[c]) : cell.text.padEnd(widths[c]), color, bold ? "bold" : undefined, cell.tone)} │`).join("");
  out.push(rule("┌", "┬", "┐"), line(headers.map((text) => ({ text })), true), rule("├", "┼", "┤"));
  for (const r of rows) out.push(line(r));
  out.push(rule("└", "┴", "┘"));
}

export function formatTable(summary: RunSummary, color: boolean, columns = 120): string {
  const out: string[] = [];
  const results = summary.results;
  const multiCollection = new Set(results.map((r) => r.collectionId)).size > 1;
  const multiIteration = summary.iterations > 1;
  const headers = [...(multiIteration ? ["#"] : []), "Result", ...(multiCollection ? ["Collection"] : []), "Method", "URL", "Status", "Time", "Tests"];
  const right = headers.map((h) => h === "Time" || h === "Tests" || h === "#");
  // Keep the table inside the terminal by shortening the URL column.
  const fixed = 3 * headers.length + 1 + 6 + 7 + 10 + 12 + 6 + (multiCollection ? 18 : 0) + (multiIteration ? 4 : 0);
  const urlMax = Math.max(24, columns - fixed);
  const rows = results.map((r) => {
    const tp = r.tests.filter((t) => t.passed).length;
    return [
      ...(multiIteration ? [{ text: String(r.iteration + 1) }] : []),
      r.passed ? { text: "PASS", tone: "green" as const } : { text: "FAIL", tone: "red" as const },
      ...(multiCollection ? [{ text: truncate(r.collectionName, 16) }] : []),
      { text: r.method, tone: "cyan" as const },
      { text: truncate(r.url, urlMax) },
      { text: r.error && !r.status ? "ERROR" : String(r.status), tone: r.passed ? ("green" as const) : ("red" as const) },
      { text: fmtMs(r.durationMs) },
      r.tests.length ? { text: `${tp}/${r.tests.length}`, tone: tp === r.tests.length ? ("green" as const) : ("red" as const) } : { text: "-" },
    ];
  });
  table(headers, right, rows, color, out);

  const failed = results.filter((r) => !r.passed);
  if (failed.length) {
    out.push("", paint("Failures:", color, "red", "bold"));
    for (const r of failed) {
      const label = [...r.path, r.name].join(" / ") + (multiIteration ? ` (iteration ${r.iteration + 1})` : "");
      const bad = r.tests.filter((t) => !t.passed);
      for (const t of bad) out.push("  " + paint(`${label} > ${t.name}${t.error ? `: ${t.error}` : ""}`, color, "red"));
      if (!bad.length) out.push("  " + paint(`${label} (${r.method} ${r.url}): ${r.error ?? `HTTP ${r.status}`}`, color, "red"));
    }
  }

  out.push("");
  const req = `${summary.total} requests, ${paint(`${summary.passed} passed`, color, summary.passed ? "green" : undefined)}, ${paint(`${summary.failed} failed`, color, summary.failed ? "red" : undefined)}`;
  const asserts = `${summary.assertions.total} assertions, ${paint(`${summary.assertions.failed} failed`, color, summary.assertions.failed ? "red" : undefined)}`;
  out.push(`Summary: ${req}; ${asserts}; ${fmtMs(summary.durationMs)} total.`);
  out.push(summary.failed ? paint("RESULT: FAIL", color, "red", "bold") : paint("RESULT: PASS", color, "green", "bold"));
  return out.join("\n");
}

/** Variables with command-line values replacing (or added after) the file's. */
function withOverrides(list: Variable[], pairs: [string, string][]): Variable[] {
  const out = list.map((v) => ({ ...v }));
  for (const [key, value] of pairs) {
    const hit = out.find((v) => v.key === key);
    if (hit) Object.assign(hit, { value, enabled: true });
    else out.push({ key, value, enabled: true });
  }
  return out;
}

// ---- main -----------------------------------------------------------------

export async function run(args: RunArgs): Promise<number> {
  const dir = resolve(args.workspace);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CliError(`Workspace folder not found: ${dir}`);
  if (!(await WorkspaceStore.isWorkspace(dir))) throw new CliError(`Not a Yamlet workspace (no collections/ and environments/): ${dir}`);
  const store = await WorkspaceStore.open(dir);
  const ws = store.workspace;

  let globals = ws.globals;
  if (args.globals) {
    const path = resolve(args.globals);
    if (!existsSync(path)) throw new CliError(`Globals file not found: ${path}`);
    globals = globalsFromYaml(readFileSync(path, "utf8"));
  }
  let environment = resolveEnvironment(ws, args.env);
  if (args.envVars.length) environment = { ...(environment ?? newEnvironment({ name: "(command line)" })), variables: withOverrides(environment?.variables ?? [], args.envVars) };
  if (args.globalVars.length) globals = withOverrides(globals, args.globalVars);
  for (const f of args.caFiles) if (!existsSync(resolve(f))) throw new CliError(`CA certificate not found: ${resolve(f)}`);

  let collectionIds: string[] | undefined;
  if (args.collections.length) {
    collectionIds = args.collections.map((name) => {
      const c = ws.collections.find((x) => x.name.toLowerCase() === name.toLowerCase() || basename(x.directoryPath ?? "") === name);
      if (!c) throw new CliError(`Collection '${name}' not found. Available: ${ws.collections.map((x) => x.name).join(", ") || "none"}.`);
      return c.id;
    });
  }

  let folderId: string | undefined;
  if (args.folder) {
    const name = args.folder.toLowerCase();
    const search = (folders: YamletFolder[]): YamletFolder | undefined => {
      for (const f of folders) {
        if (f.name.toLowerCase() === name) return f;
        const hit = search(f.folders);
        if (hit) return hit;
      }
      return undefined;
    };
    const scope = ws.collections.filter((x) => !collectionIds || collectionIds.includes(x.id));
    const hit = scope.map((x) => search(x.folders)).find(Boolean);
    if (!hit) throw new CliError(`Folder '${args.folder}' not found${collectionIds ? " in the chosen collections" : ""}.`);
    folderId = hit.id;
  }

  let data: Record<string, unknown>[] | undefined;
  if (args.data) {
    const path = resolve(args.data);
    if (!existsSync(path)) throw new CliError(`Data file not found: ${path}`);
    try {
      data = parseDataFile(readFileSync(path, "utf8"), path);
    } catch (err) {
      throw new CliError(`Could not read data file ${path}: ${(err as Error).message}`);
    }
    if (!data.length) throw new CliError(`Data file has no rows: ${path}`);
  }

  const table = args.reporter === "table";
  const log = (s = "") => (table ? console.log(s) : console.error(s));
  const c = args.color && (table ? process.stdout.isTTY !== false : process.stderr.isTTY !== false);
  log(paint(`Yamlet ${VERSION}`, c, "bold"));
  log(`${paint("Workspace:  ", c, "dim")} ${ws.rootPath}`);
  log(`${paint("Environment:", c, "dim")} ${environment?.name ?? "(none)"}`);
  if (data) log(`${paint("Data:       ", c, "dim")} ${basename(args.data!)} (${data.length} rows)`);
  log();

  const summary = await runCollection({
    workspace: ws,
    workspaceRoot: ws.rootPath,
    collectionIds,
    folderId,
    environment,
    globals,
    defaultTimeoutMs: args.timeoutMs,
    network: { ...defaultNetworkSettings(), verifySsl: !args.insecure, caCertificatePaths: args.caFiles.map((f) => resolve(f)) },
    iterations: args.iterations,
    data,
    delayMs: args.delayMs,
    bail: args.bail,
    cookieJar: new CookieJar(),
  });

  if (summary.total === 0) {
    console.error("No requests found to run.");
    return 1;
  }

  if (table) {
    console.log(formatTable(summary, c, process.stdout.columns || 120));
  } else {
    const report = args.reporter === "junit" ? formatJunit(summary) : formatJson(summary);
    if (args.out) {
      writeFileSync(resolve(args.out), report + "\n");
      log(`Wrote ${args.reporter} report to ${resolve(args.out)}`);
    } else {
      console.log(report);
    }
    log(`${summary.total} requests, ${summary.passed} passed, ${summary.failed} failed; ${fmtMs(summary.durationMs)} total.`);
  }
  return summary.failed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log(VERSION);
    return 0;
  }
  if (cmd !== "run") {
    console.error(`Unknown command '${cmd}'.\n`);
    console.log(USAGE);
    return 1;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  try {
    return await run(parseArgs(rest));
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
