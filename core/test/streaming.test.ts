import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
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
});
