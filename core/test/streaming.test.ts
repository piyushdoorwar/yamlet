import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRequest } from "../src/models.js";
import { execute, type ResponseHead } from "../src/requestExecutor.js";
import { parseEventStream, SseParser } from "../src/sse.js";

describe("SseParser", () => {
  it("parses events across chunk boundaries and line endings", () => {
    const p = new SseParser();
    expect(p.push("data: one\n\nevent: tick\nda")).toEqual([{ event: "message", data: "one" }]);
    expect(p.push("ta: {\"n\":1}\r\nid: 7\r\n\r")).toEqual([]);
    expect(p.push("\n: comment\ndata: a\ndata: b\n\n", 120)).toEqual([
      { event: "tick", data: '{"n":1}', id: "7", atMs: 120 },
      { event: "message", data: "a\nb", id: "7", atMs: 120 },
    ]);
  });

  it("dispatches a trailing event without its blank line at the end", () => {
    expect(parseEventStream("\uFEFFretry: 500\ndata:x")).toEqual([{ event: "message", data: "x", retry: 500 }]);
  });
});

describe("streamed responses", () => {
  let server: Server;
  let base: string;
  let handler: (res: ServerResponse) => void;

  beforeEach(async () => {
    server = createServer((_req, res) => handler(res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("reports the head and each body piece as it arrives", async () => {
    handler = (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      setTimeout(() => res.end("data: 2\n\n"), 30);
    };
    const heads: ResponseHead[] = [];
    const pieces: string[] = [];
    const { response } = await execute({
      request: newRequest({ url: `${base}/events` }),
      globals: [],
      workspaceRoot: os.tmpdir(),
      onHead: (h) => heads.push(h),
      onChunk: (c) => pieces.push(Buffer.from(c).toString()),
    });
    expect(heads).toEqual([expect.objectContaining({ statusCode: 200, contentType: "text/event-stream" })]);
    expect(pieces.join("")).toBe("data: 1\n\ndata: 2\n\n");
    expect(pieces.length).toBeGreaterThan(1);
    expect(response.body).toBe("data: 1\n\ndata: 2\n\n");
    expect(response.incomplete).toBeUndefined();
  });

  it("keeps the partial body when the timeout fires mid-body", async () => {
    handler = (res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
    };
    const { response } = await execute({
      request: newRequest({ url: `${base}/slow`, settings: { timeoutMs: 150, followRedirects: true, skipSslVerification: false } }),
      globals: [],
      workspaceRoot: os.tmpdir(),
    });
    expect(response.isError).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("partial");
    expect(response.incomplete).toMatch(/Timed out after 150 ms/);
  });

  it("has no timeout by default", async () => {
    handler = (res) => setTimeout(() => res.end("late"), 200);
    const { response } = await execute({ request: newRequest({ url: `${base}/late` }), globals: [], workspaceRoot: os.tmpdir() });
    expect(response.body).toBe("late");
  });

  it("sends default Accept headers the request can override, and decodes compressed bodies", async () => {
    const body = JSON.stringify({ text: "compressed ".repeat(50) });
    let seen: Record<string, string | string[] | undefined> = {};
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      seen = req.headers;
      const enc = req.url === "/br" ? "br" : "gzip";
      res.writeHead(200, { "content-type": "application/json", "content-encoding": enc });
      res.end(enc === "br" ? zlib.brotliCompressSync(body) : zlib.gzipSync(body));
    });
    const gz = await execute({ request: newRequest({ url: `${base}/gz` }), globals: [], workspaceRoot: os.tmpdir() });
    expect(seen.accept).toBe("*/*");
    expect(seen["accept-encoding"]).toBe("gzip, deflate, br");
    expect(gz.response.body).toBe(body);
    expect(gz.response.sizeBytes).toBe(body.length);
    expect(gz.response.encodedSizeBytes).toBeLessThan(body.length);

    const br = await execute({
      request: newRequest({ url: `${base}/br`, headers: [{ key: "accept", value: "application/json", enabled: true }] }),
      globals: [],
      workspaceRoot: os.tmpdir(),
    });
    expect(seen.accept).toBe("application/json");
    expect(br.response.body).toBe(body);
  });

  it("cuts bodies off at the size limit and says so", async () => {
    handler = (res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("a".repeat(600));
      res.end("b".repeat(600));
    };
    const { response } = await execute({ request: newRequest({ url: `${base}/big` }), globals: [], workspaceRoot: os.tmpdir(), maxResponseBytes: 1000 });
    expect(response.sizeBytes).toBe(1000);
    expect(response.body).toBe("a".repeat(600) + "b".repeat(400));
    expect(response.incomplete).toMatch(/larger than/);
  });

  it("reports connection phases, then reuse, and where the request went", async () => {
    handler = (res) => res.end("ok");
    const first = (await execute({ request: newRequest({ url: `${base}/a` }), globals: [], workspaceRoot: os.tmpdir() })).response;
    expect(first.timings.tcp).toBeGreaterThanOrEqual(0);
    expect(first.timings.reusedConnection).toBeUndefined();
    expect(first.network).toMatchObject({ httpVersion: "1.1", remoteAddress: "127.0.0.1", remotePort: Number(new URL(base).port) });
    // The pool frees the socket a moment after the body ends.
    await new Promise((r) => setTimeout(r, 20));
    const second = (await execute({ request: newRequest({ url: `${base}/b` }), globals: [], workspaceRoot: os.tmpdir() })).response;
    expect(second.timings).toMatchObject({ reusedConnection: true });
    expect(second.timings.tcp).toBeUndefined();
  });

  it("shows a body with codings it can't decode as binary, and lets a broken gzip stream go", async () => {
    let closed = false;
    handler = (res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip, br" });
      res.end("still-encoded");
    };
    const multi = (await execute({ request: newRequest({ url: `${base}/multi` }), globals: [], workspaceRoot: os.tmpdir() })).response;
    expect(multi.bodyEncoding).toBe("base64");
    expect(multi.incomplete).toMatch(/still encoded with "gzip, br"/);

    handler = (res) => {
      res.on("close", () => (closed = true));
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.write("not gzip at all");
      // Keeps the connection open, as a stream would.
    };
    const broken = (await execute({ request: newRequest({ url: `${base}/broken` }), globals: [], workspaceRoot: os.tmpdir() })).response;
    expect(broken.incomplete).toMatch(/connection closed before the body was complete/);
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });
});
