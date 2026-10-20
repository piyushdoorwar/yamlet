import { describe, expect, it } from "vitest";
import { generateSnippet } from "../src/codegen.js";
import { parseCurl, tokenizeShell, tryParseCurl } from "../src/curl.js";
import { buildRequest } from "../src/requestBuilder.js";

describe("parseCurl", () => {
  it("tokenizes quotes, escapes and continuations", () => {
    expect(tokenizeShell(`curl 'a b' "c \\"d\\"" e\\ f \\\n  $'x\\ny'`)).toEqual(["curl", "a b", 'c "d"', "e f", "x\ny"]);
  });

  it("parses method, headers, JSON body and query params", () => {
    const r = parseCurl(`curl -X POST 'https://api.test/users?page=2&q=a%20b' \\
      -H 'Content-Type: application/json' \\
      -H "Accept: */*" \\
      --data-raw '{"name":"x"}'`);
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.test/users");
    expect(r.queryParams).toEqual([
      { key: "page", value: "2", enabled: true },
      { key: "q", value: "a%20b", enabled: true },
    ]);
    expect(r.headers).toContainEqual({ key: "Accept", value: "*/*", enabled: true });
    expect(r.body).toMatchObject({ type: "json", raw: '{"name":"x"}' });
    expect(r.name).toBe("POST /users");
  });

  it("infers POST from data and detects JSON without a content type", () => {
    const r = parseCurl(`curl https://api.test -d '{"a":1}'`);
    expect(r.method).toBe("POST");
    expect(r.body.type).toBe("json");
  });

  it("maps form-style data and --data-urlencode to urlencoded fields", () => {
    const r = parseCurl(`curl https://api.test -d 'a=1&b=two%20words' --data-urlencode 'c=x y'`);
    expect(r.body.type).toBe("urlencoded");
    expect(r.body.fields).toEqual([
      { key: "a", value: "1", enabled: true },
      { key: "b", value: "two words", enabled: true },
      { key: "c", value: "x y", enabled: true },
    ]);
  });

  it("parses multipart fields with files", () => {
    const r = parseCurl(`curl --url https://api.test/up -F 'file=@/tmp/a.txt;type=text/plain' -F 'name="doc"'`);
    expect(r.method).toBe("POST");
    expect(r.body.type).toBe("form-data");
    expect(r.body.fields).toEqual([
      { key: "file", value: "/tmp/a.txt", enabled: true, isFile: true, contentType: "text/plain" },
      { key: "name", value: "doc", enabled: true, isFile: false },
    ]);
    const typed = parseCurl(`curl https://h/u -F 'meta={"a":1};type=application/json' -F 'g=@a.png;filename=b.png' -F 'q="x;y";type=text/plain'`);
    expect(typed.body.fields).toEqual([
      { key: "meta", value: '{"a":1}', enabled: true, isFile: false, contentType: "application/json" },
      { key: "g", value: "a.png", enabled: true, isFile: true },
      { key: "q", value: "x;y", enabled: true, isFile: false, contentType: "text/plain" },
    ]);
  });

  it("keeps query values as written, so encoded + and % survive", () => {
    const r = parseCurl(`curl 'https://h/x?ts=00%2B05:30&sig=ab%2Bcd%3D%3D&p=50%2541'`);
    expect(buildRequest(r, { ctx: {} }).url).toBe("https://h/x?ts=00%2B05:30&sig=ab%2Bcd%3D%3D&p=50%2541");
  });

  it("handles flag clusters, value flags before the URL and Windows cmd quoting", () => {
    const r = parseCurl(`curl -sSLk --max-redirs 3 https://api.test/a -d '-xyz'`);
    expect(r).toMatchObject({ url: "https://api.test/a", method: "POST", body: { raw: "-xyz" } });
    expect(r.settings.skipSslVerification).toBe(true);
    expect(parseCurl("curl -sXPUT https://api.test/a").method).toBe("PUT");
    const cmd = parseCurl('curl ^"https://api.test/a?x=1^&y=2^" ^\n  -H ^"accept: application/json^" ^\n  --data-raw ^"^{^\\^"a^\\^":1^}^"');
    expect(cmd.url).toBe("https://api.test/a");
    expect(cmd.queryParams.map((q) => `${q.key}=${q.value}`)).toEqual(["x=1", "y=2"]);
    expect(cmd.headers).toEqual([{ key: "accept", value: "application/json", enabled: true }]);
    expect(cmd.body.raw).toBe('{"a":1}');
  });

  it("maps -u, bearer headers, cookies and flags", () => {
    const basic = parseCurl(`curl -u user:pa:ss https://api.test -k -L --compressed -s`);
    expect(basic.auth).toMatchObject({ type: "basic", username: "user", password: "pa:ss" });
    expect(basic.settings.skipSslVerification).toBe(true);
    const bearer = parseCurl(`curl https://api.test -H 'Authorization: Bearer abc123' -b 'sid=1; x=2' -A 'curl/8'`);
    expect(bearer.auth).toMatchObject({ type: "bearer", token: "abc123" });
    expect(bearer.headers).toContainEqual({ key: "Cookie", value: "sid=1; x=2", enabled: true });
    expect(bearer.headers.some((h) => h.key.toLowerCase() === "authorization")).toBe(false);
    expect(bearer.headers).toContainEqual({ key: "User-Agent", value: "curl/8", enabled: true });
    const cookieOnly = parseCurl(`curl https://api.test --cookie 'sid=1'`);
    expect(cookieOnly.auth).toMatchObject({ type: "cookie", cookie: "sid=1" });
  });

  it("reads digest auth, an OAuth bearer and bodies from files", () => {
    expect(parseCurl(`curl --digest -u bob:pw https://api.test`).auth).toMatchObject({ type: "digest", username: "bob", password: "pw" });
    expect(parseCurl(`curl --oauth2-bearer tok https://api.test`).auth).toMatchObject({ type: "bearer", token: "tok" });
    const file = parseCurl(`curl -X POST https://api.test -d @body.json`);
    expect(file.body).toMatchObject({ type: "binary", binaryFile: "body.json" });
    expect(parseCurl(`curl https://api.test --data-raw '@literal'`).body).toMatchObject({ raw: "@literal" });
  });

  it("handles -G, -I, --max-time, attached options and long=value options", () => {
    const g = parseCurl(`curl -G https://api.test/s -d q=1`);
    expect(g.method).toBe("GET");
    expect(g.queryParams).toEqual([{ key: "q", value: "1", enabled: true }]);
    expect(parseCurl(`curl -I https://api.test`).method).toBe("HEAD");
    expect(parseCurl(`curl --max-time 2.5 https://api.test`).settings.timeoutMs).toBe(2500);
    expect(parseCurl(`curl -XPUT --url=https://api.test/x`).method).toBe("PUT");
    expect(parseCurl(`curl -o out.txt https://api.test/y`).url).toBe("https://api.test/y");
  });

  it("rejects non-curl input", () => {
    expect(tryParseCurl("wget https://x")).toBeUndefined();
    expect(tryParseCurl("curl -X GET")).toBeUndefined();
    expect(() => parseCurl("")).toThrow();
  });

  it("round-trips through the curl snippet generator", () => {
    const original = parseCurl(`curl -X PATCH 'https://api.test/items/1?x=1' -H 'X-Trace: t' -H 'Content-Type: application/json' --data-raw '{"a":"it'\\''s"}'`);
    expect(original.body.raw).toBe(`{"a":"it's"}`);
    const again = parseCurl(generateSnippet("curl", buildRequest(original, { ctx: {} })));
    expect(again.method).toBe("PATCH");
    expect(again.url).toBe(original.url);
    expect(again.queryParams).toEqual(original.queryParams);
    expect(again.body.raw).toBe(original.body.raw);
    expect(again.headers.find((h) => h.key === "X-Trace")?.value).toBe("t");
  });
});
