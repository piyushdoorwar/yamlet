import { describe, expect, it } from "vitest";
import { CONSOLE_BODY_CHARS, entryFromResponse, parseLog, useConsole } from "../src/lib/consoleLog";

const response = {
  statusCode: 200,
  reasonPhrase: "OK",
  durationMs: 12,
  sizeBytes: 5,
  resolvedUrl: "https://api.test/x",
  method: "GET",
  requestHeaders: [],
  headers: [],
  cookies: [],
  body: "x".repeat(CONSOLE_BODY_CHARS + 10),
  bodyEncoding: "utf8" as const,
  contentType: "text/plain",
  timings: { total: 12 },
  testResults: [],
  scriptLogs: ["plain", "[warn] careful", "[error] broken"],
  consoleText: "",
  isError: false,
};

describe("console log", () => {
  it("reads script log levels from their prefix", () => {
    expect(parseLog("[error] boom")).toEqual({ level: "error", text: "boom" });
    expect(parseLog("[warn]x")).toEqual({ level: "warn", text: "x" });
    expect(parseLog("hello [error]")).toEqual({ level: "log", text: "hello [error]" });
  });

  it("keeps a clipped copy of the exchange with its logs", () => {
    const e = entryFromResponse("Get x", response);
    expect(e).toMatchObject({ requestName: "Get x", method: "GET", url: "https://api.test/x", status: 200, binary: false });
    expect(e.responseBody.startsWith("x".repeat(CONSOLE_BODY_CHARS))).toBe(true);
    expect(e.responseBody).toMatch(/\[\.\.\. 10 more characters\]$/);
    expect(e.logs.map((l) => l.level)).toEqual(["log", "warn", "error"]);
    expect(entryFromResponse("e", { ...response, isError: true, errorMessage: "ECONNREFUSED" }).error).toBe("ECONNREFUSED");
  });

  it("caps how many entries it keeps", () => {
    const { add, clear } = useConsole.getState();
    clear();
    for (let i = 0; i < 400; i++) add(entryFromResponse(String(i), response));
    const entries = useConsole.getState().entries;
    expect(entries.length).toBe(300);
    expect(entries.at(-1)?.requestName).toBe("399");
  });
});
