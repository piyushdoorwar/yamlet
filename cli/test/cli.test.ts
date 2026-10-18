import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../core/src/collectionRunner.js";
import { WorkspaceStore } from "../../core/src/workspaceStore.js";
import { formatJunit, formatTable, parseArgs, run } from "../src/index.js";

const summary: RunSummary = {
  results: [
    { iteration: 0, requestId: "a", name: "List", path: ["Users"], collectionId: "c", collectionName: "API", method: "GET", url: "https://x.test/users", status: 200, durationMs: 12, sizeBytes: 10, tests: [{ name: "ok", passed: true }], passed: true },
    { iteration: 0, requestId: "b", name: "Create <new>", path: [], collectionId: "c", collectionName: "API", method: "POST", url: "https://x.test/users", status: 500, durationMs: 30, sizeBytes: 0, tests: [{ name: "is 201", passed: false, error: "expected 500 to equal 201" }], passed: false },
  ],
  total: 2,
  passed: 1,
  failed: 1,
  durationMs: 42,
  iterations: 1,
  assertions: { total: 2, failed: 1 },
  variables: { globals: [], collections: {} },
  stopped: false,
};

describe("cli", () => {
  it("parses options", () => {
    const a = parseArgs(["./ws", "--env", "dev", "-c", "API", "-n", "3", "--bail", "--reporter", "junit", "-o", "out.xml", "--no-color"]);
    expect(a).toMatchObject({ workspace: "./ws", env: "dev", collections: ["API"], iterations: 3, bail: true, reporter: "junit", out: "out.xml", color: false });
  });

  it("parses CI options", () => {
    const a = parseArgs(["ws", "-f", "Users", "--timeout", "5000", "-k", "--env-var", "token=a=b", "--global-var", "x=1", "--ca", "ca.pem"]);
    expect(a).toMatchObject({ folder: "Users", timeoutMs: 5000, insecure: true, envVars: [["token", "a=b"]], globalVars: [["x", "1"]], caFiles: ["ca.pem"] });
    expect(() => parseArgs(["ws", "--env-var", "novalue"])).toThrow(/key=value/);
  });

  it("runs one folder with command-line variables", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yamlet-cli-"));
    const server = createServer((req, res) => res.end(JSON.stringify({ path: req.url })));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const store = await WorkspaceStore.create(dir);
      const c = await store.createCollection("API");
      const inner = await store.createFolder(c.id, null, "Inner");
      await store.createRequest(c.id, inner.id, { name: "Ping", url: "{{base}}/ping?who={{who}}" });
      await store.createRequest(c.id, null, { name: "Outside", url: "{{base}}/outside" });
      const out = path.join(dir, "report.json");
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const code = await run(parseArgs([dir, "-f", "inner", "--env-var", `base=${base}`, "--global-var", "who=ci", "--timeout", "5000", "-r", "json", "-o", out, "--no-color"]));
      expect(code).toBe(0);
      const report = JSON.parse(await fs.readFile(out, "utf8"));
      expect(report.results.map((r: { url: string }) => r.url)).toEqual([`${base}/ping?who=ci`]);
      await expect(run(parseArgs([dir, "-f", "Nope", "--no-color"]))).rejects.toThrow(/Folder 'Nope' not found/);
    } finally {
      server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad input", () => {
    expect(() => parseArgs([])).toThrow(/Missing <workspace>/);
    expect(() => parseArgs(["ws", "--env"])).toThrow(/requires a value/);
    expect(() => parseArgs(["ws", "-n", "0"])).toThrow(/at least 1/);
    expect(() => parseArgs(["ws", "--reporter", "tap"])).toThrow(/Unknown reporter/);
    expect(() => parseArgs(["ws", "--what"])).toThrow(/Unknown option/);
  });

  it("prints a table with failures and a summary", () => {
    const out = formatTable(summary, false);
    expect(out).toContain("PASS");
    expect(out).toContain("FAIL");
    expect(out).toContain("Create <new> > is 201: expected 500 to equal 201");
    expect(out).toContain("Summary: 2 requests, 1 passed, 1 failed; 2 assertions, 1 failed");
    expect(out).toContain("RESULT: FAIL");
    expect(out).not.toContain("\x1b[");
  });

  it("writes escaped JUnit XML", () => {
    const x = formatJunit(summary);
    expect(x).toContain('<testsuite name="API" tests="2" failures="1"');
    expect(x).toContain('name="Users / List"');
    expect(x).toContain("Create &lt;new&gt;");
    expect(x).toContain('<failure message="is 201: expected 500 to equal 201">');
  });
});
