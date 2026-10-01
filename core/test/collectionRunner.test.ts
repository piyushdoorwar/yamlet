import os from "node:os";
import path from "node:path";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDataFile, planRun, runCollection, type RunOptions } from "../src/collectionRunner.js";
import { newCollection, newEnvironment, newFolder, newRequest, type YamletCollection, type YamletWorkspace } from "../src/models.js";
import { WorkspaceStore } from "../src/workspaceStore.js";

let agent: MockAgent;
let urls: string[];

function serve(handler: (path: string) => { status?: number; body?: string } = () => ({})) {
  agent
    .get("https://api.test")
    .intercept({ path: () => true, method: () => true })
    .reply((opts) => {
      urls.push(`https://api.test${opts.path}`);
      const r = handler(opts.path);
      return { statusCode: r.status ?? 200, data: r.body ?? "{}", responseOptions: { headers: { "content-type": "application/json" } } };
    })
    .persist();
}

const workspaceWith = (...collections: YamletCollection[]): YamletWorkspace => ({
  name: "t",
  rootPath: os.tmpdir(),
  collectionsPath: "",
  environmentsPath: "",
  globalsPath: "",
  collections,
  environments: [],
  globals: [],
});

const run = (workspace: YamletWorkspace, extra: Partial<RunOptions> = {}) =>
  runCollection({ workspace, workspaceRoot: os.tmpdir(), globals: [], dispatcher: agent, ...extra });

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  urls = [];
});
afterEach(async () => {
  await agent.close();
});

describe("runCollection", () => {
  it("passes when tests pass", async () => {
    serve();
    const c = newCollection({ name: "Smoke" });
    c.requests.push(newRequest({ name: "health", url: "https://api.test/health", postResponseScript: "pm.test('status is 200', () => pm.expect(pm.response.code).to.equal(200));" }));
    const s = await run(workspaceWith(c));
    expect(s).toMatchObject({ total: 1, passed: 1, failed: 0, iterations: 1, stopped: false });
    expect(s.results[0].tests).toEqual([{ name: "status is 200", passed: true }]);
    expect(s.results[0]).toMatchObject({ name: "health", method: "GET", status: 200, passed: true, path: [], collectionName: "Smoke" });
  });

  it("fails on non-2xx/3xx status, failed assertions and transport errors", async () => {
    serve((p) => (p === "/boom" ? { status: 500 } : { body: '{"items":[]}' }));
    const c = newCollection();
    c.requests.push(
      newRequest({ name: "boom", url: "https://api.test/boom" }),
      newRequest({ name: "users", url: "https://api.test/users", postResponseScript: "pm.test('has items', () => pm.expect(pm.response.json().items.length).to.above(0));" }),
      newRequest({ name: "down", url: "https://down.test/x" }),
    );
    const s = await run(workspaceWith(c));
    expect(s.results.map((r) => r.passed)).toEqual([false, false, false]);
    expect(s.results[0].error).toMatch(/500/);
    expect(s.results[2].error).toBeTruthy();
    expect(s.assertions).toEqual({ total: 1, failed: 1 });
  });

  it("walks folders before root requests, depth-first, with folder paths", async () => {
    serve();
    const c = newCollection({ name: "Smoke" });
    const setup = newFolder({ name: "setup" });
    const inner = newFolder({ name: "inner" });
    inner.requests.push(newRequest({ name: "deep", url: "https://api.test/deep" }));
    setup.folders.push(inner);
    setup.requests.push(newRequest({ name: "login", url: "https://api.test/login" }));
    c.folders.push(setup);
    c.requests.push(newRequest({ name: "root", url: "https://api.test/root" }));
    const s = await run(workspaceWith(c));
    expect(urls).toEqual(["https://api.test/deep", "https://api.test/login", "https://api.test/root"]);
    expect(s.results.map((r) => r.path)).toEqual([["setup", "inner"], ["setup"], []]);

    urls = [];
    await run(workspaceWith(c), { folderId: setup.id });
    expect(urls).toEqual(["https://api.test/deep", "https://api.test/login"]);

    urls = [];
    await run(workspaceWith(c), { requestIds: [c.requests[0].id, inner.requests[0].id] });
    expect(urls).toEqual(["https://api.test/root", "https://api.test/deep"]);
    expect(planRun(workspaceWith(c), { requestIds: ["nope"] })).toEqual([]);
  });

  it("stops after the first failure with bail", async () => {
    serve((p) => (p === "/first" ? { status: 500 } : {}));
    const c = newCollection();
    c.requests.push(newRequest({ name: "first", url: "https://api.test/first" }), newRequest({ name: "second", url: "https://api.test/second" }));
    const s = await run(workspaceWith(c), { bail: true });
    expect(s.total).toBe(1);
    expect(s.stopped).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it("chains variables set by scripts into later requests and reports resolved URLs", async () => {
    serve(() => ({ body: '{"id":"abc"}' }));
    const c = newCollection({ variables: [] });
    c.requests.push(
      newRequest({ name: "create", url: "https://api.test/create", postResponseScript: "pm.environment.set('id', pm.response.json().id); pm.collectionVariables.set('n', '1');" }),
      newRequest({ name: "fetch", url: "https://api.test/items/{{id}}?n={{n}}" }),
    );
    const environment = newEnvironment({ name: "dev" });
    const s = await run(workspaceWith(c), { environment });
    expect(urls[1]).toBe("https://api.test/items/abc?n=1");
    expect(s.results[1].url).toBe("https://api.test/items/abc?n=1");
    expect(environment.variables).toEqual([]); // caller's data untouched
    expect(s.variables.environment).toEqual([{ key: "id", value: "abc", enabled: true }]);
    expect(s.variables.collections[c.id]).toEqual([{ key: "n", value: "1", enabled: true }]);
  });

  it("runs iterations with data rows and reports progress", async () => {
    serve();
    const c = newCollection();
    c.requests.push(newRequest({ name: "q", url: "https://api.test/q/{{user}}", postResponseScript: "pm.test('iter', () => pm.expect(pm.iterationData.get('user')).to.be.a('string'));" }));
    const seen: number[] = [];
    const s = await run(workspaceWith(c), { data: [{ user: "a" }, { user: "b" }], onResult: (r) => seen.push(r.iteration) });
    expect(urls).toEqual(["https://api.test/q/a", "https://api.test/q/b"]);
    expect(s.iterations).toBe(2);
    expect(seen).toEqual([0, 1]);

    urls = [];
    const s3 = await run(workspaceWith(c), { iterations: 3 });
    expect(s3.total).toBe(3);
  });

  it("honors abort signals and delays", async () => {
    serve();
    const c = newCollection();
    c.requests.push(newRequest({ url: "https://api.test/1" }), newRequest({ url: "https://api.test/2" }));
    const controller = new AbortController();
    const p = run(workspaceWith(c), { delayMs: 200, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const s = await p;
    expect(s.stopped).toBe(true);
    expect(s.total).toBe(1);
  });

  it("runs the sample workspace offline with a mocked server", async () => {
    const store = await WorkspaceStore.open(path.resolve(__dirname, "../../samples/demo"));
    agent
      .get("https://jsonplaceholder.typicode.com")
      .intercept({ path: () => true, method: () => true })
      .reply((opts) => {
        if (opts.method === "POST") return { statusCode: 201, data: '{"id":101}', responseOptions: { headers: { "content-type": "application/json" } } };
        if (opts.path === "/posts/1") return { statusCode: 200, data: '{"id":1}', responseOptions: { headers: { "content-type": "application/json" } } };
        return { statusCode: 200, data: "[1]", responseOptions: { headers: { "content-type": "application/json" } } };
      })
      .persist();
    const s = await runCollection({
      store,
      workspaceRoot: store.rootPath,
      environment: store.workspace.environments[0],
      globals: store.workspace.globals,
      dispatcher: agent,
    });
    expect(s.results.map((r) => r.name)).toEqual(["List Users", "List Posts", "Get Post", "Create Post"]);
    expect(s.failed).toBe(0);
    expect(s.assertions.total).toBe(8);
  });
});

describe("parseDataFile", () => {
  it("parses CSV with quotes, CRLF and BOM", () => {
    const rows = parseDataFile('﻿name,note\r\nAda,"says ""hi"", twice"\r\nBob,"multi\nline"\r\n\r\n', "data.csv");
    expect(rows).toEqual([
      { name: "Ada", note: 'says "hi", twice' },
      { name: "Bob", note: "multi\nline" },
    ]);
  });

  it("parses JSON arrays and stringifies values", () => {
    expect(parseDataFile('[{"a":1,"b":{"c":true}},{"a":null}]', "rows.json")).toEqual([{ a: "1", b: '{"c":true}' }, { a: "" }]);
    expect(() => parseDataFile("[1]", "rows.json")).toThrow();
  });
});
