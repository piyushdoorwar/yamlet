import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

let root: string;
let app: FastifyInstance;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const host = "localhost:7878";

async function makeApp() {
  return buildApp({ config: {
    version: "test", browseRoot: root, defaultWorkspace: join(root, "ws"),
    inContainer: false, publicUrl: "http://localhost:7878", defaultTimeoutMs: 5000,
    interceptorDataDir: join(root, "private"),
  } });
}

const webHeaders = () => ({ host, "x-yamlet": "1", "x-yamlet-workspace": encodeURIComponent(join(root, "ws")) });
const extHeaders = { host, origin: extensionOrigin, "x-yamlet": "1" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "yamlet-interceptor-"));
  await mkdir(join(root, "ws"));
  app = await makeApp();
  await app.inject({ method: "POST", url: "/api/workspace/create", headers: webHeaders(), payload: { path: join(root, "ws") } });
});
afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

it("pairs a local extension, imports encrypted cookies, reconciles deletion, and survives a restart", async () => {
  const started = await app.inject({ method: "POST", url: "/api/interceptor/pair/start", headers: webHeaders() });
  expect(started.statusCode).toBe(200);
  const blocked = await app.inject({ method: "POST", url: "/api/interceptor/pair/finish", headers: webHeaders(), payload: { code: started.json().code } });
  expect(blocked.statusCode).toBe(403);
  const paired = await app.inject({ method: "POST", url: "/api/interceptor/pair/finish", headers: extHeaders, payload: { code: started.json().code } });
  expect(paired.statusCode).toBe(200);
  const { pairingId, secret } = paired.json();

  const sync = async (cookies: unknown[]) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "base64url"), iv);
    const body = Buffer.from(JSON.stringify({ site: "https://example.com", cookies }));
    const encrypted = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
    return app.inject({ method: "POST", url: "/api/interceptor/sync", headers: extHeaders, payload: { pairingId, iv: iv.toString("base64url"), ciphertext: encrypted.toString("base64url") } });
  };
  const cookie = { name: "session", value: "secret", domain: "example.com", path: "/", hostOnly: true, secure: true, httpOnly: true };
  expect((await sync([cookie])).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/cookies", headers: webHeaders() })).json()).toMatchObject([{ name: "session", value: "secret" }]);
  await app.close();
  app = await makeApp();
  expect((await sync([cookie])).statusCode).toBe(200);
  expect((await sync([])).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/cookies", headers: webHeaders() })).json()).toEqual([]);
});
