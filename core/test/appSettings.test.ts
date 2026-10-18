import { promises as fs } from "node:fs";
import { createServer, request, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostMatches } from "../src/agents.js";
import { normalizeSettings, SettingsFile } from "../src/appSettings.js";
import { defaultAppSettings, newRequest } from "../src/models.js";
import { execute } from "../src/requestExecutor.js";

describe("settings file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "yamlet-settings-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts from the given defaults and saves owner-only JSON", async () => {
    const file = await SettingsFile.open(dir, { ...defaultAppSettings(), timeoutMs: 5000 });
    expect(file.get().timeoutMs).toBe(5000);
    await file.save({ ...file.get(), maxResponseMb: 10, network: { ...file.get().network, proxy: { mode: "custom", url: "http://p.local:3128", bypass: "localhost" } } });
    const again = await SettingsFile.open(dir);
    expect(again.get()).toMatchObject({ timeoutMs: 5000, maxResponseMb: 10, network: { proxy: { mode: "custom", url: "http://p.local:3128" } } });
    if (process.platform !== "win32") expect((await fs.stat(path.join(dir, "settings.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects settings that can't work and repairs odd values", async () => {
    const file = await SettingsFile.open(undefined);
    await expect(file.save({ network: { proxy: { mode: "custom", url: "proxy.local" } } })).rejects.toThrow(/as a URL/);
    await expect(file.save({ network: { clientCertificates: [{ host: "api.test" }] } })).rejects.toThrow(/certificate and key/);
    expect(normalizeSettings({ timeoutMs: -5, network: { proxy: { mode: "bogus" } } })).toMatchObject({ timeoutMs: 0, network: { proxy: { mode: "system" } } });
  });
});

describe("client certificate hosts", () => {
  it("matches exact hosts, wildcards and ports", () => {
    expect(hostMatches("api.example.com", "api.example.com", "")).toBe(true);
    expect(hostMatches("API.example.com", "api.example.com", "")).toBe(true);
    expect(hostMatches("*.example.com", "a.b.example.com", "")).toBe(true);
    expect(hostMatches("*.example.com", "example.com", "")).toBe(false);
    expect(hostMatches("api.example.com:8443", "api.example.com", "8443")).toBe(true);
    expect(hostMatches("api.example.com:8443", "api.example.com", "")).toBe(false);
    expect(hostMatches("https://api.example.com/", "api.example.com", "")).toBe(true);
  });
});

describe("proxy", () => {
  let target: Server;
  let proxy: Server;
  let tunnels: string[];
  let targetUrl: string;
  let proxyUrl: string;

  beforeEach(async () => {
    tunnels = [];
    target = createServer((_req, res) => res.end("hello"));
    // A small forward proxy: plain HTTP requests in absolute form, and CONNECT tunnels.
    proxy = createServer((req, res) => {
      tunnels.push(new URL(req.url ?? "").host);
      const out = request(req.url ?? "", { method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      req.pipe(out);
    });
    proxy.on("connect", (req, client, head) => {
      tunnels.push(req.url ?? "");
      const [host, port] = (req.url ?? "").split(":");
      const upstream = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    target.closeAllConnections();
    proxy.closeAllConnections();
    await new Promise((r) => target.close(r));
    await new Promise((r) => proxy.close(r));
  });

  const send = (proxySettings: { mode: "none" | "custom"; url: string; bypass: string }) =>
    execute({
      request: newRequest({ url: targetUrl }),
      globals: [],
      workspaceRoot: os.tmpdir(),
      network: { ...defaultAppSettings().network, proxy: proxySettings },
    });

  it("sends through a custom proxy, and skips it for bypassed hosts", async () => {
    const via = await send({ mode: "custom", url: proxyUrl, bypass: "" });
    expect(via.response.body).toBe("hello");
    expect(tunnels).toEqual([new URL(targetUrl).host]);

    const direct = await send({ mode: "custom", url: proxyUrl, bypass: "127.0.0.1" });
    expect(direct.response.body).toBe("hello");
    expect(tunnels).toHaveLength(1);
  });

  it("reports an unreadable CA file as the request's error", async () => {
    const { response } = await execute({
      request: newRequest({ url: targetUrl }),
      globals: [],
      workspaceRoot: os.tmpdir(),
      network: { ...defaultAppSettings().network, caCertificatePaths: ["/no/such/ca.pem"] },
    });
    expect(response.isError).toBe(true);
    expect(response.errorMessage).toMatch(/Could not read the CA certificate \/no\/such\/ca\.pem/);
  });
});
