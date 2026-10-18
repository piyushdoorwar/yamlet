import { describe, expect, it } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import { newRequest, type ScriptTestResult, type YamletResponse } from "../src/models.js";
import { runScript, ScriptVariables } from "../src/scriptRunner.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function response(partial: Partial<YamletResponse> = {}): YamletResponse {
  return {
    statusCode: 200,
    reasonPhrase: "OK",
    durationMs: 12,
    sizeBytes: 2,
    resolvedUrl: "https://api.test",
    method: "GET",
    requestHeaders: [],
    headers: [{ key: "content-type", value: "application/json", enabled: true }],
    cookies: [{ name: "sid", value: "abc" }],
    body: '{"id":5,"items":[1,2],"name":"Yamlet"}',
    bodyEncoding: "utf8",
    contentType: "application/json",
    timings: { total: 12 },
    testResults: [],
    scriptLogs: [],
    consoleText: "",
    isError: false,
    ...partial,
  };
}

async function run(script: string, opts: { phase?: "pre" | "post"; vars?: ScriptVariables; throwOnFailure?: boolean; res?: YamletResponse } = {}) {
  const tests: ScriptTestResult[] = [];
  const logs: string[] = [];
  const request = newRequest({ url: "https://api.test/items", headers: [{ key: "Accept", value: "*/*", enabled: true }] });
  const variables = opts.vars ?? new ScriptVariables({ environment: [], collection: [], globals: [] });
  await runScript({
    script,
    phase: opts.phase ?? "post",
    request,
    response: opts.phase === "pre" ? undefined : (opts.res ?? response()),
    variables,
    tests,
    logs,
    throwOnFailure: opts.throwOnFailure,
  });
  return { tests, logs, request, variables };
}

describe("runScript", () => {
  it("captures each pm.test and continues past failures", async () => {
    const { tests } = await run(`
pm.test('passes', () => pm.expect(pm.response.code).to.equal(200));
pm.test('fails', () => pm.expect(pm.response.code).to.equal(500));
pm.test('also passes', () => pm.expect(1).to.equal(1));`);
    expect(tests.map((t) => t.passed)).toEqual([true, false, true]);
    expect(tests[1].error).toMatch(/500/);
  });

  it("throws on a failed test when throwOnFailure is set", async () => {
    await expect(run("pm.test('fails', () => pm.expect(1).to.equal(2));", { throwOnFailure: true })).rejects.toThrow();
  });

  it("supports the chai BDD surface and response assertions", async () => {
    const { tests } = await run(`
const body = pm.response.json();
pm.test('eql', () => pm.expect(body.items).to.eql([1, 2]));
pm.test('deep', () => pm.expect(body).to.deep.include({ id: 5 }));
pm.test('above', () => pm.expect(body.id).to.be.above(1).and.below(10));
pm.test('short above', () => pm.expect(body.items.length).to.above(0));
pm.test('types', () => { pm.expect(body).to.be.an('object'); pm.expect(body.items).to.be.an('array'); pm.expect(body.name).to.be.a('string'); });
pm.test('include', () => pm.expect(body.name).to.include('aml'));
pm.test('property', () => pm.expect(body).to.have.property('name', 'Yamlet'));
pm.test('length', () => pm.expect(body.items).to.have.lengthOf(2));
pm.test('match', () => pm.expect(body.name).to.match(/^Yam/));
pm.test('not', () => pm.expect(body.missing).to.not.exist);
pm.test('ok', () => { pm.expect(true).to.be.true; pm.expect(null).to.be.null; pm.expect(undefined).to.be.undefined; pm.expect(1).to.be.ok; });
pm.test('oneOf', () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));
pm.test('status', () => pm.response.to.have.status(200));
pm.test('status reason', () => pm.response.to.have.status('OK'));
pm.test('response ok', () => pm.response.to.be.ok);
pm.test('response json', () => pm.response.to.be.json);
pm.test('header', () => pm.response.to.have.header('Content-Type', 'application/json'));
pm.test('jsonBody', () => pm.response.to.have.jsonBody('name', 'Yamlet'));
pm.test('expect response', () => pm.expect(pm.response).to.have.status(200));
pm.test('not error', () => pm.response.to.not.be.error);
pm.test('headers api', () => pm.expect(pm.response.headers.get('content-type')).to.equal('application/json'));
pm.test('cookies', () => pm.expect(pm.cookies.get('sid')).to.equal('abc'));
pm.test('timing', () => pm.expect(pm.response.responseTime).to.be.below(1000));
`);
    expect(tests.filter((t) => !t.passed)).toEqual([]);
    expect(tests).toHaveLength(23);
  });

  it("fails response assertions correctly", async () => {
    const { tests } = await run(`
pm.test('status', () => pm.response.to.have.status(404));
pm.test('notFound', () => pm.response.to.be.notFound);
pm.test('plain ok still works', () => pm.expect(0).to.be.ok);`);
    expect(tests.map((t) => t.passed)).toEqual([false, false, false]);
  });

  it("checks response time and bracketed JSON paths", async () => {
    const { tests } = await run(`
pm.test('time below', () => pm.response.to.have.responseTime.below(100));
pm.test('time above fails', () => pm.response.to.have.responseTime.above(100));
pm.test('time exact', () => pm.response.to.have.responseTime(12));
pm.test('time exact fails', () => pm.response.to.have.responseTime(13));
pm.test('bracket path', () => pm.response.to.have.jsonBody('items[1]', 2));
pm.test('missing path fails', () => pm.response.to.have.jsonBody('items[5]'));`);
    expect(tests.map((t) => t.passed)).toEqual([true, false, true, false, true, false]);
  });

  it("awaits async tests, done callbacks and timers", async () => {
    const { tests, variables } = await run(`
pm.test('async', async () => { await new Promise((r) => setTimeout(r, 10)); pm.expect(1).to.equal(2); });
pm.test('done', (done) => setTimeout(() => done(), 5));
setTimeout(() => pm.environment.set('late', 'yes'), 15);
const x = await Promise.resolve(3);
pm.test('top-level await', () => pm.expect(x).to.equal(3));`);
    expect(tests.find((t) => t.name === "async")?.passed).toBe(false);
    expect(tests.find((t) => t.name === "done")?.passed).toBe(true);
    expect(tests.find((t) => t.name === "top-level await")?.passed).toBe(true);
    expect(variables.get("environment", "late")).toBe("yes");
  });

  it("reads and writes variable scopes with tracking", async () => {
    const vars = new ScriptVariables({
      request: [{ key: "r", value: "req", enabled: true }],
      iterationData: { row: "7" },
      collection: [{ key: "c", value: "col", enabled: true }],
      environment: [{ key: "e", value: "env", enabled: true }],
      globals: [{ key: "g", value: "glob", enabled: true }],
    });
    const { logs } = await run(
      `
pm.environment.set('token', 'abc');
pm.environment.set('e', 'changed');
pm.collectionVariables.set('n', 42);
pm.globals.unset('g');
pm.variables.set('local', 'L');
console.log(pm.variables.get('r'), pm.variables.get('c'), pm.variables.get('e'), pm.variables.get('local'), pm.iterationData.get('row'));
console.log(pm.environment.has('token'), pm.environment.get('missing'), JSON.stringify(pm.environment.toObject()));
console.log(pm.variables.replaceIn('{{local}}-{{e}}'), pm.replaceIn('{{c}}'));
console.log(pm.variables.replaceIn('{{$guid}}'));
console.warn({ a: 1 });`,
      { vars, phase: "pre" },
    );
    expect(logs[0]).toBe("req col changed L 7");
    expect(logs[1]).toBe('true undefined {"e":"changed","token":"abc"}');
    expect(logs[2]).toBe("L-changed col");
    expect(logs[3]).toMatch(UUID);
    expect(logs[4]).toBe("[warn] { a: 1 }");
    const changes = vars.changes();
    expect(changes.environment).toEqual([
      { key: "e", value: "changed", enabled: true },
      { key: "token", value: "abc", enabled: true },
    ]);
    expect(changes.collectionVariables).toContainEqual({ key: "n", value: "42", enabled: true });
    expect(changes.globals).toEqual([]);
  });

  it("falls back to local variables when a scope is missing", async () => {
    const vars = new ScriptVariables({ globals: [] });
    await run("pm.environment.set('x', '1'); pm.test('t', () => pm.expect(pm.variables.get('x')).to.equal('1'));", { vars, phase: "pre" });
    expect(vars.changes().environment).toBeUndefined();
    expect(vars.toContext().request).toContainEqual({ key: "x", value: "1", enabled: true });
  });

  it("mutates the request in pre-request scripts", async () => {
    const { request } = await run(
      `
pm.request.headers.add({ key: 'X-Script', value: 'yes' });
pm.request.headers.upsert({ key: 'accept', value: 'application/json' });
pm.request.headers.remove('X-None');
pm.request.url = 'https://other.test/path?a=1&b=two';
pm.request.url.query.add({ key: 'c', value: '3' });
pm.request.method = 'post';
pm.request.body.raw = '{"x":1}';
console.log(pm.request.url.toString(), pm.request.url.getHost(), pm.request.headers.get('x-script'));`,
      { phase: "pre" },
    );
    expect(request.headers).toEqual([
      { key: "Accept", value: "application/json", enabled: true },
      { key: "X-Script", value: "yes", enabled: true },
    ]);
    expect(request.url).toBe("https://other.test/path");
    expect(request.queryParams.map((q) => `${q.key}=${q.value}`)).toEqual(["a=1", "b=two", "c=3"]);
    expect(request.method).toBe("POST");
    expect(request.body.raw).toBe('{"x":1}');
  });

  it("propagates script errors and enforces the timeout", async () => {
    await expect(run("throw new Error('boom');", { phase: "pre" })).rejects.toThrow("boom");
    await expect(run("undefinedFunction();", { phase: "pre" })).rejects.toThrow(/undefinedFunction/);
    const tests: ScriptTestResult[] = [];
    await expect(
      runScript({ script: "while (true) {}", phase: "pre", request: newRequest(), variables: new ScriptVariables(), tests, logs: [], timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/i);
  });

  it("provides base64 helpers, a restricted require and pm.info", async () => {
    const { logs } = await run(
      `console.log(btoa('hi'), atob('aGk='), typeof require('chai').expect, pm.info.eventName, pm.info.requestName);
try { require('fs'); } catch (e) { console.log(e.message); }`,
      { phase: "pre" },
    );
    expect(logs[0]).toBe("aGk= hi function prerequest New Request");
    expect(logs[1]).toMatch(/not available/);
  });

  it("rejects pm.sendRequest without a backend", async () => {
    const { logs } = await run(
      `pm.sendRequest('https://x.test', (err, res) => console.log(err ? 'err:' + err.message : res.code));`,
      { phase: "pre" },
    );
    expect(logs[0]).toMatch(/^err:/);
  });
});

describe("script libraries", () => {
  it("offers lodash, CryptoJS, Buffer and require() of common modules", async () => {
    const { logs } = await run(`
      console.log(_.sumBy([{ n: 1 }, { n: 2 }], "n"));
      console.log(require("lodash").chunk([1, 2, 3], 2).length);
      console.log(CryptoJS.HmacSHA256("msg", "key").toString(CryptoJS.enc.Hex));
      console.log(require("crypto-js").MD5("x").toString());
      console.log(Buffer.from("hi").toString("base64"), require("buffer").Buffer.from("aGk=", "base64").toString());
      console.log(require("btoa")("hi"));
    `);
    expect(logs).toEqual([
      "3",
      "2",
      "2d93cbc1be167bcb1637a4a23cbff01a7878f0c50ee833954ea5221bb1b8c628",
      "9dd4e461268c8034f5c8564e155c67a6",
      "aGk= hi",
      "aGk=",
    ]);
  });

  it("checks bodies and values against a JSON schema", async () => {
    const { tests } = await run(`
      const schema = { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } };
      pm.test("body matches", () => pm.response.to.have.jsonSchema(schema));
      pm.test("value fails", () => pm.expect({ id: "x" }).to.have.jsonSchema(schema));
    `);
    expect(tests[0]).toEqual({ name: "body matches", passed: true });
    expect(tests[1].passed).toBe(false);
    expect(tests[1].error).toMatch(/must be integer|must have required property 'name'/);
  });

  it("only lets pre-request scripts skip the request", async () => {
    const pre = await run("pm.execution.skipRequest()", { phase: "pre" });
    expect(pre.logs).toEqual([]);
    await expect(run("pm.execution.skipRequest()", { throwOnFailure: true })).rejects.toThrow(/only works in a pre-request script/);
  });
});

describe("pm.cookies.jar", () => {
  it("reads, sets and unsets jar cookies, and shows them to pre-request scripts", async () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://api.test/", ["sid=old; Path=/"]);
    const tests: ScriptTestResult[] = [];
    const logs: string[] = [];
    await runScript({
      script: `
pm.test('pre sees jar', () => pm.expect(pm.cookies.get('sid')).to.equal('old'));
const jar = pm.cookies.jar();
await new Promise((done) => jar.set('https://api.test', 'theme', 'dark', done));
await new Promise((done) => jar.get('https://api.test/x', 'theme', (err, v) => { pm.test('get', () => pm.expect(v).to.equal('dark')); done(); }));
await new Promise((done) => jar.unset('api.test', 'sid', done));`,
      phase: "pre",
      request: newRequest({ url: "{{base}}/items" }),
      variables: new ScriptVariables({ environment: [{ key: "base", value: "https://api.test", enabled: true }], collection: [], globals: [] }),
      tests,
      logs,
      cookieJar: jar,
    });
    expect(tests.map((t) => [t.name, t.passed])).toEqual([["pre sees jar", true], ["get", true]]);
    expect(jar.list().map((c) => `${c.name}=${c.value}`)).toEqual(["theme=dark"]);
  });

  it("reports a turned-off jar to the callback", async () => {
    const { logs } = await run(`pm.cookies.jar().get('https://a.test', 'x', (err) => console.log(err.message));
await new Promise((r) => setTimeout(r, 0));`);
    expect(logs.join("\n")).toContain("turned off");
  });
});
