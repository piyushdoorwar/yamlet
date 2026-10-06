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

it("only lets the extension reach the pairing finish and sync routes", async () => {
  const started = await app.inject({ method: "POST", url: "/api/interceptor/pair/start", headers: { ...extHeaders, "x-yamlet-workspace": encodeURIComponent(join(root, "ws")) } });
  expect(started.statusCode).toBe(403);
  const status = await app.inject({ method: "GET", url: "/api/interceptor/status", headers: { ...extHeaders, "x-yamlet-workspace": encodeURIComponent(join(root, "ws")) } });
  expect(status.statusCode).toBe(403);
  const preflight = await app.inject({ method: "OPTIONS", url: "/api/interceptor/sync", headers: { host, origin: extensionOrigin } });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers["access-control-allow-origin"]).toBe(extensionOrigin);
});

it("maps Chrome sameSite values and marks synced cookies", async () => {
  const started = await app.inject({ method: "POST", url: "/api/interceptor/pair/start", headers: webHeaders() });
  const paired = await app.inject({ method: "POST", url: "/api/interceptor/pair/finish", headers: extHeaders, payload: { code: ` ${started.json().code} ` } });
  const { pairingId, secret } = paired.json();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "base64url"), iv);
  const cookies = [
    { name: "a", value: "1", domain: ".example.com", path: "/", hostOnly: false, secure: true, httpOnly: false, sameSite: "no_restriction" },
    { name: "b", value: "2", domain: "app.example.com", path: "/", hostOnly: true, secure: false, httpOnly: false, sameSite: "unspecified" },
  ];
  const body = Buffer.from(JSON.stringify({ site: "https://app.example.com", cookies }));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  const synced = await app.inject({ method: "POST", url: "/api/interceptor/sync", headers: extHeaders, payload: { pairingId, iv: iv.toString("base64url"), ciphertext: encrypted.toString("base64url") } });
  expect(synced.json()).toEqual({ ok: true, count: 2 });
  const list = (await app.inject({ method: "GET", url: "/api/cookies", headers: webHeaders() })).json();
  expect(list).toHaveLength(2);
  expect(list.every((c: { fromBrowser?: boolean }) => c.fromBrowser)).toBe(true);
});

it("tells a forgotten pairing (401) apart from a disconnected one (403)", async () => {
  const pair = async () => {
    const started = await app.inject({ method: "POST", url: "/api/interceptor/pair/start", headers: webHeaders() });
    return (await app.inject({ method: "POST", url: "/api/interceptor/pair/finish", headers: extHeaders, payload: { code: started.json().code } })).json() as { pairingId: string; secret: string };
  };
  const sync = (pairingId: string, secret: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "base64url"), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ site: "https://example.com", cookies: [] })), cipher.final(), cipher.getAuthTag()]);
    return app.inject({ method: "POST", url: "/api/interceptor/sync", headers: extHeaders, payload: { pairingId, iv: iv.toString("base64url"), ciphertext: encrypted.toString("base64url") } });
  };
  const status = async () => (await app.inject({ method: "GET", url: "/api/interceptor/status", headers: webHeaders() })).json();

  const first = await pair();
  expect((await sync(first.pairingId, first.secret)).statusCode).toBe(200);

  // Lost private data: the server has never heard of the pairing, so the extension may re-pair.
  await app.close();
  await rm(join(root, "private"), { recursive: true, force: true });
  app = await makeApp();
  expect((await sync(first.pairingId, first.secret)).statusCode).toBe(401);

  // Disconnected in Yamlet: the pairing is remembered as revoked, even across a restart.
  const second = await pair();
  expect(await status()).toEqual({ paired: true });
  await app.inject({ method: "DELETE", url: "/api/interceptor/pairings", headers: webHeaders() });
  expect(await status()).toEqual({ paired: false });
  await app.close();
  app = await makeApp();
  const revoked = await sync(second.pairingId, second.secret);
  expect(revoked.statusCode).toBe(403);
  expect(revoked.json().error).toMatch(/disconnected/);
});
