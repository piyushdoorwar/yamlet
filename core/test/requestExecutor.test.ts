import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FormData, MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import { defaultAuth, defaultBody, defaultSettings, newCollection, newFolder, newEnvironment, newRequest, type Variable } from "../src/models.js";
import { clearTokenCache } from "../src/oauth2.js";
import { execute, type ExecuteInput } from "../src/requestExecutor.js";

interface Seen {
  origin: string;
  path: string;
  method: string;
  headers: Record<string, string | string[]>;
  body: unknown;
}

type Reply = { status?: number; body?: string | Buffer; headers?: Record<string, string | string[]>; delayMs?: number };

let agent: MockAgent;
let seen: Seen[];

function route(origin: string, handler: (s: Seen) => Reply = () => ({})) {
  agent
    .get(origin)
    .intercept({ path: () => true, method: () => true })
    .reply((opts) => {
      const s: Seen = { origin, path: opts.path, method: opts.method, headers: (opts.headers ?? {}) as Record<string, string | string[]>, body: opts.body };
      seen.push(s);
      const r = handler(s);
      return { statusCode: r.status ?? 200, data: r.body ?? "", responseOptions: { headers: r.headers ?? {} } };
    })
    .persist();
}

const json = (body: unknown, status = 200): Reply => ({ status, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const vars = (...pairs: [string, string][]): Variable[] => pairs.map(([key, value]) => ({ key, value, enabled: true }));
const send = (input: Partial<ExecuteInput> & Pick<ExecuteInput, "request">) =>
  execute({ globals: [], workspaceRoot: os.tmpdir(), dispatcher: agent, ...input });
const h = (s: Seen, name: string) => {
  const v = s.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : v;
};

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  seen = [];
  clearTokenCache();
});
afterEach(async () => {
  await agent.close();
});

describe("execute", () => {
  it("returns status, body, size and content type", async () => {
    route("https://example.com", () => json({ ok: true }));
    const { response } = await send({ request: newRequest({ url: "https://example.com/api" }) });
    expect(response.isError).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.reasonPhrase).toBe("OK");
    expect(response.body).toBe('{"ok":true}');
    expect(response.bodyEncoding).toBe("utf8");
    expect(response.sizeBytes).toBe(Buffer.byteLength('{"ok":true}'));
    expect(response.contentType).toContain("application/json");
    expect(response.headers).toContainEqual({ key: "content-type", value: "application/json", enabled: true });
    expect(response.timings.total).toBeGreaterThanOrEqual(0);
  });

  it("returns binary bodies as base64", async () => {
    route("https://example.com", () => ({ body: Buffer.from([0, 1, 2, 255]), headers: { "content-type": "image/png" } }));
    const { response } = await send({ request: newRequest({ url: "https://example.com/img" }) });
    expect(response.bodyEncoding).toBe("base64");
    expect(Buffer.from(response.body, "base64")).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(response.consoleText).toContain("[binary body, 4 bytes]");
  });

  it("resolves variables and appends query params", async () => {
    route("https://api.test");
    const { response } = await send({
      request: newRequest({ url: "{{baseUrl}}/users", queryParams: [{ key: "page", value: "{{page}}", enabled: true }] }),
      collection: newCollection({ variables: vars(["baseUrl", "https://api.test"], ["page", "2"]) }),
    });
    expect(seen[0].path).toBe("/users?page=2");
    expect(response.resolvedUrl).toBe("https://api.test/users?page=2");
  });

  it("applies request, inherited and overridden auth", async () => {
    route("https://api.test");
    const collection = newCollection({ auth: { ...defaultAuth("bearer"), token: "col-token" } });
    await send({ request: newRequest({ url: "https://api.test/a", auth: { ...defaultAuth("bearer"), token: "{{t}}" } }), environment: newEnvironment({ variables: vars(["t", "abc"]) }) });
    await send({ request: newRequest({ url: "https://api.test/b" }), collection });
    await send({ request: newRequest({ url: "https://api.test/c", auth: { ...defaultAuth("bearer"), token: "own" } }), collection });
    await send({ request: newRequest({ url: "https://api.test/d", auth: defaultAuth("none") }), collection });
    await send({ request: newRequest({ url: "https://api.test/e", auth: { ...defaultAuth("cookie"), cookie: "session={{sid}}" } }), globals: vars(["sid", "s1"]) });
    expect(h(seen[0], "authorization")).toBe("Bearer abc");
    expect(h(seen[1], "authorization")).toBe("Bearer col-token");
    expect(h(seen[2], "authorization")).toBe("Bearer own");
    expect(h(seen[3], "authorization")).toBeUndefined();
    expect(h(seen[4], "cookie")).toBe("session=s1");
  });

  it("sends JSON, urlencoded and multipart bodies", async () => {
    route("https://api.test", () => ({ status: 201 }));
    const body = newRequest().body;
    const ctx = { environment: newEnvironment({ variables: vars(["who", "yamlet user"]) }) };
    const r1 = await send({ ...ctx, request: newRequest({ method: "POST", url: "https://api.test/j", body: { ...body, type: "json", raw: '{"name":"{{who}}"}' } }) });
    expect(r1.response.statusCode).toBe(201);
    expect(seen[0].body).toBe('{"name":"yamlet user"}');
    expect(h(seen[0], "content-type")).toBe("application/json");

    await send({ ...ctx, request: newRequest({ method: "POST", url: "https://api.test/u", body: { ...body, type: "urlencoded", fields: [{ key: "name", value: "{{who}}", enabled: true }, { key: "skip", value: "no", enabled: false }] } }) });
    expect(seen[1].body).toBe("name=yamlet+user");
    expect(h(seen[1], "content-type")).toBe("application/x-www-form-urlencoded");

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yamlet-exec-"));
    try {
      await fs.writeFile(path.join(dir, "upload.txt"), "file content");
      const r3 = await send({
        ...ctx,
        workspaceRoot: dir,
        request: newRequest({
          method: "POST",
          url: "https://api.test/f",
          headers: [{ key: "Content-Type", value: "multipart/form-data", enabled: true }],
          body: {
            ...body,
            type: "form-data",
            fields: [
              { key: "domain", value: "{{who}}", enabled: true },
              { key: "file", value: "upload.txt", enabled: true, isFile: true },
              { key: "meta", value: '{"a":1}', enabled: true, contentType: "application/json" },
            ],
          },
        }),
      });
      // The typed multipart/form-data header is replaced by one with the boundary.
      const type = h(seen[2], "content-type") ?? "";
      expect(type).toMatch(/^multipart\/form-data; boundary=----YamletBoundary/);
      const raw = Buffer.from(seen[2].body as Buffer);
      const form = await new Response(raw, { headers: { "content-type": type } }).formData();
      expect(form.get("domain")).toBe("yamlet user");
      const file = form.get("file") as File;
      expect(file.name).toBe("upload.txt");
      expect(file.type).toBe("text/plain");
      expect(await file.text()).toBe("file content");
      expect(raw.toString()).toContain('Content-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n{"a":1}');
      expect(r3.response.requestBody).toContain("[multipart form-data]");

      await fs.writeFile(path.join(dir, "blob.bin"), Buffer.from([1, 2, 3]));
      await send({ workspaceRoot: dir, request: newRequest({ method: "PUT", url: "https://api.test/b", body: { ...body, type: "binary", binaryFile: "blob.bin" } }) });
      expect(Buffer.from(seen[3].body as Buffer)).toEqual(Buffer.from([1, 2, 3]));
      expect(h(seen[3], "content-type")).toBe("application/octet-stream");

      const missing = await send({ workspaceRoot: dir, request: newRequest({ method: "PUT", url: "https://api.test/b", body: { ...body, type: "binary", binaryFile: "nope.bin" } }) });
      expect(missing.response.isError).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("sends the request's own user agent and skips disabled headers", async () => {
    route("https://api.test");
    await send({
      request: newRequest({
        url: "https://api.test",
        headers: [
          { key: "User-Agent", value: "Other/2.0", enabled: true },
          { key: "X-On", value: "1", enabled: true },
          { key: "X-Off", value: "2", enabled: false },
        ],
      }),
    });
    expect(h(seen[0], "user-agent")).toBe("Other/2.0");
    expect(h(seen[0], "x-on")).toBe("1");
    expect(h(seen[0], "x-off")).toBeUndefined();
  });

  it("builds a console snapshot", async () => {
    route("https://api.test", () => json({ ok: true }));
    const { response } = await send({
      request: newRequest({ method: "POST", url: "{{baseUrl}}/users", headers: [{ key: "X-Trace", value: "{{traceId}}", enabled: true }], body: { ...newRequest().body, type: "json", raw: '{"name":"{{name}}"}' } }),
      collection: newCollection({ variables: vars(["baseUrl", "https://api.test"], ["traceId", "abc"], ["name", "Yamlet"]) }),
    });
    expect(response.consoleText).toContain("POST https://api.test/users");
    expect(response.consoleText).toContain("X-Trace: abc");
    expect(response.consoleText).toContain('{"name":"Yamlet"}');
    expect(response.consoleText).toContain("HTTP 200 OK");
    expect(response.consoleText).toContain('{"ok":true}');
  });

  it("runs pre-request scripts before sending and excludes them from the duration", async () => {
    agent
      .get("https://script.test")
      .intercept({ path: () => true, method: () => true })
      .reply((opts) => {
        seen.push({ origin: "https://script.test", path: opts.path, method: opts.method, headers: opts.headers as Record<string, string>, body: opts.body });
        return { statusCode: 200, data: "" };
      })
      .delay(40)
      .persist();
    const { response } = await send({
      request: newRequest({
        url: "{{baseUrl}}/users",
        preRequestScript: `
pm.variables.set('baseUrl', 'https://script.test');
pm.request.headers.add({ key: 'X-Script', value: pm.variables.get('baseUrl') });
console.log('before request');
const started = Date.now(); while (Date.now() - started < 150) {}`,
      }),
    });
    expect(seen[0].origin).toBe("https://script.test");
    expect(seen[0].path).toBe("/users");
    expect(h(seen[0], "x-script")).toBe("https://script.test");
    expect(response.scriptLogs).toContain("before request");
    expect(response.durationMs).toBeGreaterThanOrEqual(30);
    expect(response.durationMs).toBeLessThan(140);
  });

  it("returns environment changes made by scripts without mutating the input", async () => {
    route("https://api.test", () => json({ id: "env-123" }));
    const environment = newEnvironment({ variables: [] });
    const { response, changes } = await send({
      request: newRequest({ url: "https://api.test", postResponseScript: "pm.environment.set('createdId', pm.response.json().id); pm.globals.set('g', 1);" }),
      environment,
    });
    expect(response.isError).toBe(false);
    expect(changes.environment).toEqual([{ key: "createdId", value: "env-123", enabled: true }]);
    expect(changes.globals).toEqual([{ key: "g", value: "1", enabled: true }]);
    expect(changes.collectionVariables).toBeUndefined();
    expect(environment.variables).toEqual([]);
  });

  it("captures test results; script failures in post scripts do not fail the send", async () => {
    route("https://api.test", () => json({ id: 5 }));
    const { response } = await send({
      request: newRequest({
        url: "https://api.test",
        postResponseScript: "pm.test('status', () => pm.expect(pm.response.code).to.equal(200));\npm.test('bad', () => pm.expect(1).to.equal(2));\nthrow new Error('after');",
      }),
    });
    expect(response.isError).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.testResults.map((t) => [t.name, t.passed])).toEqual([
      ["status", true],
      ["bad", false],
      ["Post-response script", false],
    ]);
  });

  it("aborts with an error response when the pre-request script throws", async () => {
    route("https://api.test");
    const { response } = await send({ request: newRequest({ url: "https://api.test", preRequestScript: "throw new Error('pre failed');" }) });
    expect(response.isError).toBe(true);
    expect(response.errorMessage).toContain("pre failed");
    expect(seen).toHaveLength(0);
  });

  it("returns an error response on transport failure, timeout and cancel", async () => {
    const failing = await send({ request: newRequest({ url: "https://unreachable.invalid" }) });
    expect(failing.response.isError).toBe(true);
    expect(failing.response.errorMessage).toBeTruthy();
    expect(failing.response.consoleText).toContain("Error:");

    const invalid = await send({ request: newRequest({ url: "not a url" }) });
    expect(invalid.response.isError).toBe(true);

    agent.get("https://slow.test").intercept({ path: () => true, method: () => true }).reply(200, "late").delay(500).persist();
    const slow = await send({ request: newRequest({ url: "https://slow.test", settings: { timeoutMs: 50, followRedirects: true, skipSslVerification: false } }) });
    expect(slow.response.errorMessage).toMatch(/timed out/);

    const controller = new AbortController();
    const p = send({ request: newRequest({ url: "https://slow.test" }), signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect((await p).response.errorMessage).toBe("Request was cancelled.");
  });

  it("fetches and caches an OAuth2 client-credentials token", async () => {
    route("https://issuer.test", () => json({ access_token: "tok-123", token_type: "Bearer", expires_in: 3600 }));
    route("https://api.test");
    const auth = defaultAuth("oauth2");
    auth.oauth2 = { ...auth.oauth2, grantType: "client_credentials", accessTokenUrl: "https://issuer.test/oauth2/token", clientId: "{{cid}}", clientSecret: "{{secret}}", scope: "api/read" };
    const collection = newCollection({ auth, variables: vars(["cid", "client-1"], ["secret", "shh"]) });
    await send({ request: newRequest({ url: "https://api.test/courses" }), collection });
    await send({ request: newRequest({ url: "https://api.test/courses" }), collection });

    const tokenCalls = seen.filter((s) => s.origin === "https://issuer.test");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].method).toBe("POST");
    expect(h(tokenCalls[0], "authorization")).toBe("Basic " + Buffer.from("client-1:shh").toString("base64"));
    expect(tokenCalls[0].body).toBe("grant_type=client_credentials&scope=api%2Fread");
    const api = seen.filter((s) => s.origin === "https://api.test");
    expect(api.map((s) => h(s, "authorization"))).toEqual(["Bearer tok-123", "Bearer tok-123"]);
  });

  it("refreshes an expired OAuth2 token once, retries, and reports the new token", async () => {
    route("https://api.test", (s) => (h(s, "authorization") === "Bearer new" ? json({ ok: true }) : { status: 401, body: "expired" }));
    route("https://idp.test", (s) => {
      const form = new URLSearchParams(String(s.body));
      return form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "r1" ? json({ access_token: "new", refresh_token: "r2", expires_in: 60 }) : { status: 400, body: "bad" };
    });
    const auth = defaultAuth("oauth2");
    auth.oauth2 = { ...auth.oauth2, grantType: "authorization_code", accessToken: "old", refreshToken: "r1", accessTokenUrl: "https://idp.test/token", clientId: "app" };
    const request = newRequest({ url: "https://api.test/me", auth });

    const first = await send({ request });
    expect(first.response.statusCode).toBe(200);
    expect(first.oauthRefreshed).toEqual({ accessToken: "new", refreshToken: "r2", expiresAt: expect.any(Number), source: "request" });
    expect(first.response.scriptLogs.join("\n")).toMatch(/got a new one with the refresh token/);

    // The same saved (old) token now goes straight out as the refreshed one.
    seen = [];
    const second = await send({ request });
    expect(second.response.statusCode).toBe(200);
    expect(seen.map((x) => x.origin)).toEqual(["https://api.test"]);
  });

  it("refreshes a token past its stored expiry before sending", async () => {
    route("https://api.test", (s) => (h(s, "authorization") === "Bearer fresh" ? json({ ok: true }) : { status: 401, body: "expired" }));
    route("https://idp2.test", () => json({ access_token: "fresh", expires_in: 300 }));
    const auth = defaultAuth("oauth2");
    auth.oauth2 = { ...auth.oauth2, grantType: "authorization_code", accessToken: "stale", refreshToken: "r9", expiresAt: Date.now() - 1000, accessTokenUrl: "https://idp2.test/token", clientId: "app" };
    const res = await send({ request: newRequest({ url: "https://api.test/me", auth }) });
    expect(res.response.statusCode).toBe(200);
    expect(seen.map((s) => s.origin)).toEqual(["https://idp2.test", "https://api.test"]);
    expect(res.oauthRefreshed).toMatchObject({ accessToken: "fresh", source: "request" });
  });

  it("uses a client-credentials token in hand, and fetches a new one when it is rejected", async () => {
    route("https://api.test", (s) => (h(s, "authorization") === "Bearer pasted" || h(s, "authorization") === "Bearer issued" ? json({ ok: true }) : { status: 401, body: "no" }));
    route("https://cc.test", () => json({ access_token: "issued", expires_in: 3600 }));
    const auth = defaultAuth("oauth2");
    auth.oauth2 = { ...auth.oauth2, grantType: "client_credentials", accessTokenUrl: "https://cc.test/token", clientId: "c-pasted", accessToken: "pasted" };
    await send({ request: newRequest({ url: "https://api.test/a", auth }) });
    expect(seen.map((s) => s.origin)).toEqual(["https://api.test"]);

    seen = [];
    auth.oauth2 = { ...auth.oauth2, accessToken: "revoked" };
    const res = await send({ request: newRequest({ url: "https://api.test/a", auth }) });
    expect(res.response.statusCode).toBe(200);
    expect(seen.map((s) => s.origin)).toEqual(["https://api.test", "https://cc.test", "https://api.test"]);
    expect(res.oauthRefreshed).toMatchObject({ accessToken: "issued" });
  });

  it("reports OAuth2 token failures as error responses", async () => {
    route("https://issuer.test", () => json({ error: "invalid_client" }, 401));
    const auth = defaultAuth("oauth2");
    auth.oauth2 = { ...auth.oauth2, accessTokenUrl: "https://issuer.test/token", clientId: "c" };
    const { response } = await send({ request: newRequest({ url: "https://api.test", auth }) });
    expect(response.isError).toBe(true);
    expect(response.errorMessage).toMatch(/OAuth 2.0 token request failed/);
  });

  it("attaches a stored OAuth2 token as a query param", async () => {
    route("https://api.test");
    const auth = defaultAuth("oauth2");
    auth.oauth2 = { ...auth.oauth2, grantType: "authorization_code", accessToken: "stored-xyz", addTokenTo: "query" };
    await send({ request: newRequest({ url: "https://api.test/data", auth }) });
    expect(seen[0].path).toBe("/data?access_token=stored-xyz");
  });

  it("runs collection scripts around the request and swallows their failures", async () => {
    route("https://api.test");
    const collection = newCollection({
      preRequestScript: "pm.request.headers.add({ key: 'X-Collection', value: 'yes' }); throw new Error('collection pre broke');",
      postResponseScript: "pm.test('within', () => pm.expect(pm.response.code).to.be.within(200, 299));\npm.test('always fails', () => pm.expect(1).to.equal(2));\nnope();",
    });
    const { response } = await send({ request: newRequest({ url: "https://api.test" }), collection });
    expect(h(seen[0], "x-collection")).toBe("yes");
    expect(response.isError).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.testResults.map((t) => t.passed)).toEqual([true, false]);
    expect(response.scriptLogs.some((l) => l.includes("collection pre broke"))).toBe(true);
  });

  it("follows redirects, stores cookies and re-sends them", async () => {
    route("https://site.test", (s) => {
      if (s.path === "/login") return { status: 302, headers: { location: "/home", "set-cookie": "sid=abc; Path=/" } };
      return { status: 200, body: `cookie=${h(s, "cookie") ?? ""}` };
    });
    const cookieJar = new CookieJar();
    const { response } = await send({ request: newRequest({ method: "POST", url: "https://site.test/login", body: { ...newRequest().body, type: "text", raw: "x" } }), cookieJar });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /login", "GET /home"]);
    expect(response.body).toBe("cookie=sid=abc");
    expect(response.redirects).toEqual([{ statusCode: 302, url: "https://site.test/login" }]);
    expect(response.consoleText).toContain("HTTP 302 Found from https://site.test/login (followed)");
    expect(cookieJar.cookieHeaderFor("https://site.test/")).toBe("sid=abc");

    const noFollow = await send({ request: newRequest({ url: "https://site.test/login", settings: { timeoutMs: 0, followRedirects: false, skipSslVerification: false } }), cookieJar });
    expect(noFollow.response.statusCode).toBe(302);
    expect(noFollow.response.redirects).toBeUndefined();
    expect(noFollow.response.cookies).toContainEqual(expect.objectContaining({ name: "sid", value: "abc", domain: "site.test", path: "/" }));
  });

  it("honors max redirects, keeping the method, keeping auth across hosts and skipping the jar", async () => {
    route("https://a.test", (s) => {
      if (s.path === "/1") return { status: 302, headers: { location: "/2" } };
      if (s.path === "/2") return { status: 302, headers: { location: "https://b.test/3", "set-cookie": "k=v; Path=/" } };
      return { status: 200 };
    });
    route("https://b.test", (s) => ({ status: 200, body: `${s.method} auth=${h(s, "authorization") ?? ""}` }));
    const settings = (patch: Partial<ReturnType<typeof defaultSettings>>) => ({ ...defaultSettings(), ...patch });
    const post = (patch: Partial<ReturnType<typeof defaultSettings>>, cookieJar?: CookieJar) =>
      send({
        request: newRequest({ method: "POST", url: "https://a.test/1", headers: [{ key: "Authorization", value: "Bearer t", enabled: true }], body: { ...defaultBody(), type: "text", raw: "x" }, settings: settings(patch) }),
        cookieJar,
      });

    expect((await post({ maxRedirects: 1 })).response.statusCode).toBe(302);
    expect((await post({})).response.body).toBe("GET auth=");
    expect((await post({ followOriginalMethod: true, followAuthorizationHeader: true })).response.body).toBe("POST auth=Bearer t");

    const jar = new CookieJar();
    await post({ disableCookieJar: true }, jar);
    expect(jar.cookieHeaderFor("https://a.test/")).toBeFalsy();
    await post({}, jar);
    expect(jar.cookieHeaderFor("https://a.test/")).toBe("k=v");
  });

  it("runs folder scripts in order and inherits auth from the nearest folder that sets it", async () => {
    route("https://api.test", (x) => ({ status: 200, body: `auth=${h(x, "authorization") ?? ""}` }));
    const collection = newCollection({ auth: { ...defaultAuth("bearer"), token: "collection" }, preRequestScript: "console.log('c-pre')", postResponseScript: "console.log('c-post')" });
    const outer = newFolder({ name: "outer", auth: { ...defaultAuth("bearer"), token: "outer" }, preRequestScript: "console.log('o-pre')", postResponseScript: "console.log('o-post')" });
    const inner = newFolder({ name: "inner", preRequestScript: "console.log('i-pre')", postResponseScript: "console.log('i-post')" });
    const request = newRequest({ url: "https://api.test/x", preRequestScript: "console.log('r-pre')", postResponseScript: "console.log('r-post')" });
    const { response } = await send({ request, collection, folders: [outer, inner] });
    expect(response.scriptLogs).toEqual(["c-pre", "o-pre", "i-pre", "r-pre", "r-post", "i-post", "o-post", "c-post"]);
    expect(response.body).toBe("auth=Bearer outer");

    inner.auth = { ...defaultAuth("none") };
    expect((await send({ request, collection, folders: [outer, inner] })).response.body).toBe("auth=");
  });

  it("backs pm.sendRequest with the same transport", async () => {
    route("https://side.test", () => json({ v: 9 }));
    route("https://api.test");
    const { response } = await send({
      request: newRequest({
        url: "https://api.test/x",
        preRequestScript: "const res = await pm.sendRequest({ url: 'https://side.test/v', method: 'POST', header: { 'X-A': '1' }, body: { mode: 'raw', raw: 'hi' } }); pm.request.headers.add({ key: 'X-V', value: String(res.json().v) });",
      }),
    });
    expect(response.isError).toBe(false);
    const side = seen.find((s) => s.origin === "https://side.test")!;
    expect(side.method).toBe("POST");
    expect(side.body).toBe("hi");
    expect(h(side, "x-a")).toBe("1");
    expect(h(seen.find((s) => s.origin === "https://api.test")!, "x-v")).toBe("9");
  });

  it("sends pm.sendRequest form-data bodies as multipart", async () => {
    route("https://side.test");
    route("https://api.test");
    await send({
      request: newRequest({
        url: "https://api.test/x",
        variables: [{ key: "who", value: "ann", enabled: true }],
        preRequestScript: "await pm.sendRequest({ url: 'https://side.test/f', method: 'POST', body: { mode: 'formdata', formdata: [{ key: 'name', value: '{{who}}' }, { key: 'off', value: 'x', disabled: true }] } });",
      }),
    });
    const side = seen.find((s) => s.origin === "https://side.test")!;
    expect(h(side, "content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const body = Buffer.from(side.body as unknown as Uint8Array).toString();
    expect(body).toContain('name="name"\r\n\r\nann\r\n');
    expect(body).not.toContain("off");
  });
});

describe("transport error messages", () => {
  it("explains AggregateErrors with empty messages", async () => {
    const { errMessage } = await import("../src/requestExecutor.js");
    const inner = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
    const agg = Object.assign(new AggregateError([inner], ""), { code: "ECONNREFUSED" });
    expect(errMessage(agg)).toBe("connect ECONNREFUSED 10.0.0.1:443; (connection refused)");
    expect(errMessage(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.test"), { code: "ENOTFOUND" }) }))).toBe(
      "getaddrinfo ENOTFOUND api.test; (host name could not be resolved)",
    );
    expect(errMessage(Object.assign(new Error(""), { code: "UND_ERR_CONNECT_TIMEOUT" }))).toBe("UND_ERR_CONNECT_TIMEOUT: connection timed out");
    expect(errMessage({})).toMatch(/without an error message/);
  });

  it("replaces OpenSSL's raw lines with what they mean", async () => {
    const { errMessage } = await import("../src/requestExecutor.js");
    const raw = "40DED77270760000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:../deps/openssl/ssl/record.c:77:";
    expect(errMessage(Object.assign(new Error(raw), { code: "ERR_SSL_WRONG_VERSION_NUMBER" }))).toBe("ERR_SSL_WRONG_VERSION_NUMBER: the TLS handshake failed; is this an http:// server?");
    expect(errMessage(Object.assign(new Error(raw), { code: "ERR_SSL_OTHER" }))).toBe("wrong version number; ERR_SSL_OTHER");
    expect(errMessage(Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }))).toContain("CA certificate in Settings");
  });
});

describe("QUERY method", () => {
  it("sends QUERY with its body, and keeps both across a 307 redirect", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get("https://api.test");
    pool.intercept({ path: "/search", method: "QUERY" }).reply(307, "", { headers: { location: "/v2/search" } });
    pool
      .intercept({ path: "/v2/search", method: "QUERY", body: (b) => b === '{"q":"cats"}' })
      .reply(200, { hits: 3 }, { headers: { "content-type": "application/json" } });
    const request = newRequest({ method: "QUERY", url: "https://api.test/search", body: { ...defaultBody(), type: "json", raw: '{"q":"cats"}' } });
    const { response } = await execute({ request, globals: [], workspaceRoot: "/tmp", dispatcher: agent });
    expect(response.isError).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.method).toBe("QUERY");
    expect(JSON.parse(response.body)).toEqual({ hits: 3 });
    await agent.close();
  });
});
