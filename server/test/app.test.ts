import type { FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, WORKSPACE_HEADER } from "../../shared/api.js";
import { buildApp } from "../src/app.js";

let root: string;
let app: FastifyInstance;
let agent: MockAgent;

async function makeApp() {
  agent = new MockAgent();
  agent.disableNetConnect();
  return buildApp({
    config: {
      version: "test",
      browseRoot: root,
      defaultWorkspace: join(root, "ws"),
      inContainer: false,
      publicUrl: "http://localhost:7878",
      defaultTimeoutMs: 5000,
      dispatcher: agent,
    },
  });
}

const H = { host: "localhost:7878" };
const W = () => ({ ...H, [CSRF_HEADER]: "1", [WORKSPACE_HEADER]: encodeURIComponent(join(root, "ws")) });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "yamlet-server-"));
  await mkdir(join(root, "ws"));
  app = await makeApp();
});

afterEach(async () => {
  await app.close();
  await agent.close();
  await rm(root, { recursive: true, force: true });
});

describe("security", () => {
  it("rejects requests not addressed to localhost", async () => {
    const res = await app.inject({ method: "GET", url: "/api/info", headers: { host: "evil.example" } });
    expect(res.statusCode).toBe(403);
  });

  it("rejects cross-origin requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/info", headers: { ...H, origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
  });

  it("requires the CSRF header on state changes", async () => {
    const res = await app.inject({ method: "POST", url: "/api/workspace/create", headers: H, payload: { path: join(root, "ws") } });
    expect(res.statusCode).toBe(403);
  });

  it("sets protective headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health", headers: H });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("keeps the folder browser inside the browse root", async () => {
    const res = await app.inject({ method: "GET", url: `/api/fs/list?path=${encodeURIComponent("/etc")}`, headers: H });
    expect(res.statusCode).toBe(403);
  });
});

describe("workspace lifecycle", () => {
  it("creates a workspace, then a collection, folder, request and environment on disk", async () => {
    const created = await app.inject({ method: "POST", url: "/api/workspace/create", headers: W(), payload: { path: join(root, "ws") } });
    expect(created.statusCode).toBe(200);

    const col = await app.inject({ method: "POST", url: "/api/collections", headers: W(), payload: { name: "Pets API" } });
    expect(col.statusCode).toBe(200);
    const collectionId = col.json().item.id as string;

    const folder = await app.inject({ method: "POST", url: "/api/folders", headers: W(), payload: { collectionId, parentFolderId: null, name: "Cats" } });
    const folderId = folder.json().item.id as string;

    const req = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: W(),
      payload: { collectionId, parentFolderId: folderId, init: { name: "List cats", method: "GET", url: "{{baseUrl}}/cats" } },
    });
    expect(req.statusCode).toBe(200);
    const request = req.json().item;
    expect(request.sourceFilePath).toBeTruthy();
    expect(await readFile(request.sourceFilePath, "utf8")).toContain("{{baseUrl}}/cats");

    const env = await app.inject({ method: "POST", url: "/api/environments", headers: W(), payload: { name: "dev", variables: [{ key: "baseUrl", value: "https://pets.test", enabled: true }] } });
    expect(env.json().item.variables[0].key).toBe("baseUrl");

    const reopened = await app.inject({ method: "POST", url: "/api/workspace/open", headers: W(), payload: { path: join(root, "ws") } });
    const ws = reopened.json().workspace;
    expect(ws.collections[0].name).toBe("Pets API");
    expect(ws.collections[0].folders[0].requests[0].name).toBe("List cats");
    expect(ws.environments[0].name).toBe("dev");
  });

  it("returns 404 when the folder is not a workspace", async () => {
    const res = await app.inject({ method: "POST", url: "/api/workspace/open", headers: W(), payload: { path: join(root, "ws") } });
    expect(res.statusCode).toBe(404);
  });
});

describe("send", () => {
  it("resolves variables, sends through the dispatcher, and runs tests", async () => {
    await app.inject({ method: "POST", url: "/api/workspace/create", headers: W(), payload: { path: join(root, "ws") } });
    const collectionId = (await app.inject({ method: "POST", url: "/api/collections", headers: W(), payload: { name: "C" } })).json().item.id;
    const envRes = await app.inject({ method: "POST", url: "/api/environments", headers: W(), payload: { name: "dev", variables: [{ key: "baseUrl", value: "https://api.test", enabled: true }] } });
    const environmentId = envRes.json().item.id;
    const request = (
      await app.inject({
        method: "POST",
        url: "/api/requests",
        headers: W(),
        payload: {
          collectionId,
          parentFolderId: null,
          init: {
            name: "Get user",
            method: "GET",
            url: "{{baseUrl}}/users/1",
            postResponseScript: "pm.test('is 200', () => pm.response.to.have.status(200)); pm.environment.set('userName', pm.response.json().name);",
          },
        },
      })
    ).json().item;

    agent
      .get("https://api.test")
      .intercept({ path: "/users/1", method: "GET" })
      .reply(200, { id: 1, name: "Ada" }, { headers: { "content-type": "application/json" } });

    const res = await app.inject({ method: "POST", url: "/api/send", headers: W(), payload: { request, collectionId, environmentId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.response.statusCode).toBe(200);
    expect(body.response.resolvedUrl).toBe("https://api.test/users/1");
    expect(body.response.testResults).toEqual([expect.objectContaining({ name: "is 200", passed: true })]);
    // The script's pm.environment.set was persisted.
    const env = body.workspace.environments.find((e: { id: string }) => e.id === environmentId);
    expect(env.variables.find((v: { key: string }) => v.key === "userName").value).toBe("Ada");
  });

  it("uploads attachments into the workspace files/ folder", async () => {
    await app.inject({ method: "POST", url: "/api/workspace/create", headers: W(), payload: { path: join(root, "ws") } });
    const boundary = "----yamlet";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../avatar.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`;
    const res = await app.inject({ method: "POST", url: "/api/files", headers: { ...W(), "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("files/avatar.png");
  });
});

describe("import", () => {
  it("imports an OpenAPI document as a collection", async () => {
    await app.inject({ method: "POST", url: "/api/workspace/create", headers: W(), payload: { path: join(root, "ws") } });
    const doc = {
      openapi: "3.0.0",
      info: { title: "Petstore", version: "1" },
      servers: [{ url: "https://pets.test/v1" }],
      paths: { "/pets/{id}": { get: { summary: "Get pet", tags: ["pets"], parameters: [{ name: "id", in: "path", required: true }] } } },
    };
    const res = await app.inject({ method: "POST", url: "/api/import", headers: W(), payload: { text: JSON.stringify(doc) } });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.kind).toBe("collection");
    const c = out.workspace.collections.find((x: { id: string }) => x.id === out.collectionId);
    expect(c.name).toBe("Petstore");
  });

  it("parses a cURL command into a request without writing it", async () => {
    await writeFile(join(root, "placeholder"), "");
    await app.inject({ method: "POST", url: "/api/workspace/create", headers: W(), payload: { path: join(root, "ws") } });
    const res = await app.inject({ method: "POST", url: "/api/import", headers: W(), payload: { text: "curl -X POST https://api.test/x -H 'A: b' -d '{\"a\":1}'" } });
    expect(res.json().kind).toBe("request");
    expect(res.json().request.method).toBe("POST");
  });
});
