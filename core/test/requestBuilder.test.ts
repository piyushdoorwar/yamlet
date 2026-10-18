import { describe, expect, it } from "vitest";
import { generateSnippet, SNIPPET_LANGUAGES, snippetSigns } from "../src/codegen.js";
import { defaultAuth, newCollection, newRequest, yamletUserAgent } from "../src/models.js";
import { applyPathVariables, buildRequest, encodeTypedQueryComponent } from "../src/requestBuilder.js";

const header = (b: ReturnType<typeof buildRequest>, name: string) => b.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

describe("buildRequest", () => {
  it("resolves URL, query and path variables", () => {
    const r = newRequest({
      url: "{{baseUrl}}/users/:id/posts/:postId",
      queryParams: [
        { key: "page", value: "{{page}}", enabled: true },
        { key: "q", value: "a b&c", enabled: true },
        { key: "off", value: "1", enabled: false },
      ],
      pathVariables: [
        { key: "id", value: "{{uid}}" },
        { key: "postId", value: "7" },
      ],
    });
    const b = buildRequest(r, { ctx: { environment: [{ key: "baseUrl", value: "http://localhost:8080", enabled: true }, { key: "page", value: "2", enabled: true }, { key: "uid", value: "42", enabled: true }] } });
    expect(b.url).toBe("http://localhost:8080/users/42/posts/7?page=2&q=a%20b%26c");
    expect(b.method).toBe("GET");
  });

  it("does not touch ports or unrelated colons", () => {
    expect(applyPathVariables("http://h:8080/a/:id?x=:id", [{ key: "id", value: "1" }])).toBe("http://h:8080/a/1?x=:id");
    expect(applyPathVariables("http://h/a/:identity", [{ key: "id", value: "1" }])).toBe("http://h/a/:identity");
  });

  it("sends the Yamlet user agent unless the request sets one, and skips disabled headers", () => {
    const r = newRequest({
      url: "https://x.test",
      headers: [
        { key: "User-Agent", value: "Other/2.0", enabled: true },
        { key: "X-On", value: "1", enabled: true },
        { key: "X-Off", value: "2", enabled: false },
      ],
    });
    const b = buildRequest(r, { ctx: {} });
    expect(b.headers.filter((h) => h.key.toLowerCase() === "user-agent")).toEqual([{ key: "User-Agent", value: "Other/2.0", enabled: true }]);
    expect(header(b, "X-On")).toBe("1");
    expect(header(b, "X-Off")).toBeUndefined();
    expect(header(buildRequest(newRequest({ url: "https://x.test" }), { ctx: {} }), "User-Agent")).toBe(yamletUserAgent());
  });

  it("lets the request's own auth header win and combines cookies", () => {
    const r = newRequest({ url: "https://x.test", headers: [{ key: "authorization", value: "Token mine", enabled: true }, { key: "Cookie", value: "a=1", enabled: true }] });
    r.auth = { ...defaultAuth("bearer"), token: "inherited" };
    const b = buildRequest(r, { ctx: {} });
    expect(b.headers.filter((h) => h.key.toLowerCase() === "authorization").map((h) => h.value)).toEqual(["Token mine"]);
    r.auth = { ...defaultAuth("cookie"), cookie: "session=xyz" };
    expect(buildRequest(r, { ctx: {} }).headers.filter((h) => h.key === "Cookie").map((h) => h.value)).toEqual(["a=1; session=xyz"]);
  });

  it("escapes path variable values and types binary bodies by extension", () => {
    expect(applyPathVariables("http://h/files/:name", [{ key: "name", value: "a b/c?d#e%zz%20" }])).toBe("http://h/files/a%20b%2Fc%3Fd%23e%25zz%20");
    const r = newRequest({ url: "https://x.test", method: "POST" });
    r.body.type = "binary";
    r.body.binaryFile = "files/photo.PNG";
    expect(buildRequest(r, { ctx: {} }).body).toMatchObject({ kind: "binary", contentType: "image/png" });
  });

  it("applies auth types and inheritance", () => {
    const ctx = { environment: [{ key: "tok", value: "abc", enabled: true }] };
    const bearer = buildRequest(newRequest({ url: "https://x.test", auth: { ...defaultAuth("bearer"), token: "{{tok}}" } }), { ctx });
    expect(header(bearer, "Authorization")).toBe("Bearer abc");
    const basic = buildRequest(newRequest({ url: "https://x.test", auth: { ...defaultAuth("basic"), username: "u", password: "pé" } }), { ctx });
    expect(header(basic, "Authorization")).toBe("Basic " + Buffer.from("u:pé").toString("base64"));
    const apiq = buildRequest(newRequest({ url: "https://x.test/a?z=1", auth: { ...defaultAuth("apikey"), apiKeyName: "key", apiKeyValue: "v v", apiKeyIn: "query" } }), { ctx });
    expect(apiq.url).toBe("https://x.test/a?z=1&key=v%20v");
    const cookie = buildRequest(newRequest({ url: "https://x.test", auth: { ...defaultAuth("cookie"), cookie: "s=1" } }), { ctx });
    expect(header(cookie, "Cookie")).toBe("s=1");

    const collection = newCollection({ auth: { ...defaultAuth("bearer"), token: "col" } });
    expect(header(buildRequest(newRequest({ url: "https://x.test" }), { ctx, collection }), "Authorization")).toBe("Bearer col");
    expect(header(buildRequest(newRequest({ url: "https://x.test", auth: defaultAuth("none") }), { ctx, collection }), "Authorization")).toBeUndefined();
    expect(header(buildRequest(newRequest({ url: "https://x.test", auth: { ...defaultAuth("bearer"), token: "own" } }), { ctx, collection }), "Authorization")).toBe("Bearer own");

    const oauth = defaultAuth("oauth2");
    oauth.oauth2.accessToken = "stored";
    expect(header(buildRequest(newRequest({ url: "https://x.test", auth: oauth }), { ctx }), "Authorization")).toBe("Bearer stored");
    expect(header(buildRequest(newRequest({ url: "https://x.test", auth: oauth }), { ctx, oauthToken: "fresh" }), "Authorization")).toBe("Bearer fresh");
    oauth.oauth2.addTokenTo = "query";
    expect(buildRequest(newRequest({ url: "https://x.test/d", auth: oauth }), { ctx }).url).toBe("https://x.test/d?access_token=stored");
  });

  it("builds bodies with default content types", () => {
    const body = newRequest().body;
    const json = buildRequest(newRequest({ method: "post", body: { ...body, type: "json", raw: '{"n":"{{who}}"}' } }), { ctx: { request: [{ key: "who", value: "y", enabled: true }] } });
    expect(json.method).toBe("POST");
    expect(json.body).toEqual({ kind: "text", text: '{"n":"y"}', contentType: "application/json" });
    expect(header(json, "Content-Type")).toBe("application/json");
    expect(header(buildRequest(newRequest({ body: { ...body, type: "xml", raw: "<a/>" } }), { ctx: {} }), "content-type")).toBe("application/xml");
    expect(header(buildRequest(newRequest({ body: { ...body, type: "html", raw: "<p>" } }), { ctx: {} }), "content-type")).toBe("text/html");
    const custom = buildRequest(newRequest({ headers: [{ key: "content-type", value: "application/vnd+json", enabled: true }], body: { ...body, type: "json", raw: "{}" } }), { ctx: {} });
    expect(custom.headers.filter((h) => h.key.toLowerCase() === "content-type")).toHaveLength(1);
    expect(custom.body).toMatchObject({ contentType: "application/vnd+json" });

    const gql = buildRequest(newRequest({ body: { ...body, type: "graphql", graphqlQuery: "query { me }", graphqlVariables: '{"a":1}' } }), { ctx: {} });
    expect(gql.body.kind === "text" && JSON.parse(gql.body.text)).toEqual({ query: "query { me }", variables: { a: 1 } });
    expect(header(gql, "Content-Type")).toBe("application/json");

    const urlenc = buildRequest(newRequest({ body: { ...body, type: "urlencoded", fields: [{ key: "a", value: "1", enabled: true }, { key: "b", value: "2", enabled: false }] } }), { ctx: {} });
    expect(urlenc.body).toEqual({ kind: "urlencoded", fields: [{ key: "a", value: "1" }] });
    expect(header(urlenc, "Content-Type")).toBe("application/x-www-form-urlencoded");

    const form = buildRequest(newRequest({ body: { ...body, type: "form-data", fields: [{ key: "t", value: "x", enabled: true }, { key: "f", value: "@a.txt", enabled: true }] } }), { ctx: {} });
    expect(form.body).toEqual({ kind: "form-data", fields: [{ key: "t", value: "x", isFile: false }, { key: "f", value: "a.txt", isFile: true }] });
    expect(header(form, "Content-Type")).toBeUndefined();

    const bin = buildRequest(newRequest({ body: { ...body, type: "binary", binaryFile: "a.bin" } }), { ctx: {} });
    expect(bin.body).toMatchObject({ kind: "binary", file: "a.bin" });
    expect(buildRequest(newRequest({ body: { ...body, type: "json", raw: "" } }), { ctx: {} }).body.kind).toBe("none");
  });
});

describe("URL encoding", () => {
  const url = (u: string, params: [string, string][] = []) =>
    buildRequest(newRequest({ url: u, queryParams: params.map(([key, value]) => ({ key, value, enabled: true })) }), { ctx: { scopes: [] } as never }).url;

  it("sends typed params as typed, escaping only what a query can't carry", () => {
    expect(url("https://x.test/s", [["q", "a%20b"], ["tags", "a,b"], ["t", "2024-01-01T00:00:00+05:30"]])).toBe(
      "https://x.test/s?q=a%20b&tags=a,b&t=2024-01-01T00:00:00+05:30",
    );
    expect(url("https://x.test/s", [["q", "a b&c#d"], ["filter", '{"x":1}'], ["name", "Zoë"], ["eq", "a=b"]])).toBe(
      "https://x.test/s?q=a%20b%26c%23d&filter=%7B%22x%22:1%7D&name=Zo%C3%AB&eq=a=b",
    );
    expect(encodeTypedQueryComponent("a=b", true)).toBe("a%3Db");
    expect(encodeTypedQueryComponent("100%")).toBe("100%25");
  });

  it("fully escapes the values of variables in params", () => {
    const ctx = { environment: [{ key: "sig", value: "ab+c/d==", enabled: true }, { key: "pct", value: "100%25off", enabled: true }] };
    const built = buildRequest(newRequest({ url: "https://x.test/s", queryParams: [{ key: "sig", value: "{{sig}}", enabled: true }, { key: "p", value: "x-{{pct}}+{{nope}}", enabled: true }] }), { ctx: ctx as never });
    expect(built.url).toBe("https://x.test/s?sig=ab%2Bc%2Fd%3D%3D&p=x-100%2525off+%7B%7Bnope%7D%7D");
  });

  it("fully escapes values it adds itself", () => {
    const req = newRequest({ url: "https://x.test", auth: { ...defaultAuth("apikey"), apiKeyName: "key", apiKeyValue: "a+b/c", apiKeyIn: "query" } });
    expect(buildRequest(req, { ctx: { scopes: [] } as never }).url).toBe("https://x.test?key=a%2Bb%2Fc");
  });

  it("assumes http:// when the URL has no scheme", () => {
    expect(url("example.com/x")).toBe("http://example.com/x");
    expect(url("localhost:3000/api")).toBe("http://localhost:3000/api");
    expect(url("https://example.com")).toBe("https://example.com");
  });
});

describe("codegen", () => {
  const body = newRequest().body;
  const samples = [
    buildRequest(newRequest({ url: "https://api.test/users?x=1" }), { ctx: {} }),
    buildRequest(newRequest({ method: "POST", url: "https://api.test/u", headers: [{ key: "X-T", value: "it's", enabled: true }], body: { ...body, type: "json", raw: '{"a":"b"}' } }), { ctx: {} }),
    buildRequest(newRequest({ method: "POST", url: "https://api.test/u", body: { ...body, type: "urlencoded", fields: [{ key: "a", value: "b c", enabled: true }] } }), { ctx: {} }),
    buildRequest(newRequest({ method: "POST", url: "https://api.test/u", body: { ...body, type: "form-data", fields: [{ key: "t", value: "x", enabled: true }, { key: "f", value: "a.txt", enabled: true, isFile: true }, { key: "g", value: "b.txt", enabled: true, isFile: true }] } }), { ctx: {} }),
    buildRequest(newRequest({ method: "PUT", url: "https://api.test/u", body: { ...body, type: "binary", binaryFile: "a.bin" } }), { ctx: {} }),
  ];

  it("generates every language for every body kind", () => {
    expect(SNIPPET_LANGUAGES.map((l) => l.id)).toEqual(["curl", "httpie", "wget", "http", "javascript-fetch", "node-axios", "python-requests", "go", "csharp-httpclient", "java-okhttp", "php-curl", "powershell", "ruby"]);
    for (const lang of SNIPPET_LANGUAGES) {
      for (const b of samples) {
        const s = generateSnippet(lang.id, b);
        expect(s.length).toBeGreaterThan(10);
        expect(s).toContain(lang.id === "http" ? "/u" : "api.test");
      }
    }
    expect(() => generateSnippet("cobol", samples[0])).toThrow();
  });

  it("produces correct curl", () => {
    expect(generateSnippet("curl", samples[0])).toBe("curl --location 'https://api.test/users?x=1' \\\n  --header 'User-Agent: Yamlet/dev'");
    const post = generateSnippet("curl", samples[1]);
    expect(post).toContain("--request POST");
    expect(post).toContain(`--header 'X-T: it'\\''s'`);
    expect(post).toContain(`--data-raw '{"a":"b"}'`);
    expect(generateSnippet("curl", samples[3])).toContain("--form 'f=@a.txt'");
  });

  it("produces a raw HTTP message", () => {
    const s = generateSnippet("http", samples[1]);
    expect(s.split("\n")[0]).toBe("POST /u HTTP/1.1");
    expect(s).toContain("Host: api.test");
    expect(s.endsWith('{"a":"b"}')).toBe(true);
  });

  it("scopes Go file fields in blocks", () => {
    const s = generateSnippet("go", samples[3]);
    expect(s.match(/file, err := os.Open/g)).toHaveLength(2);
    expect(s).toContain("writer.FormDataContentType()");
  });
});

describe("QUERY snippets", () => {
  it("keeps the body and uses -CustomMethod for PowerShell", async () => {
    const { buildRequest } = await import("../src/requestBuilder.js");
    const { generateSnippet } = await import("../src/codegen.js");
    const { newRequest, defaultBody } = await import("../src/models.js");
    const built = buildRequest(newRequest({ method: "QUERY", url: "https://api.test/search", body: { ...defaultBody(), type: "json", raw: '{"q":1}' } }), { ctx: {} });
    expect(built.method).toBe("QUERY");
    expect(built.body).toMatchObject({ kind: "text", text: '{"q":1}' });
    expect(generateSnippet("curl", built)).toContain("--request QUERY");
    expect(generateSnippet("powershell", built)).toContain("-CustomMethod 'QUERY'");
    expect(generateSnippet("powershell", { ...built, method: "GET" })).toContain("-Method 'GET'");
  });
});

describe("build problems", () => {
  it("names an undefined variable in the host instead of letting DNS fail", () => {
    expect(buildRequest(newRequest({ url: "{{baseUrl}}/users" }), { ctx: {} }).problems).toEqual([expect.stringContaining("{{baseUrl}}")]);
    expect(buildRequest(newRequest({ url: "https://api.test/{{id}}" }), { ctx: {} }).problems).toBeUndefined();
  });

  it("reports GraphQL variables that aren't JSON", () => {
    const r = newRequest({ url: "https://api.test/graphql", method: "POST" });
    r.body.type = "graphql";
    r.body.graphqlQuery = "query { a }";
    r.body.graphqlVariables = "{ id: 1 }";
    expect(buildRequest(r, { ctx: {} }).problems?.[0]).toMatch(/GraphQL variables aren't valid JSON/);
    r.body.graphqlVariables = '{"id": {{id}}}';
    expect(buildRequest(r, { ctx: { environment: [{ key: "id", value: "3", enabled: true }] } }).problems).toBeUndefined();
  });
});

describe("snippets for send-time auth", () => {
  it("adds Digest and AWS SigV4 to cURL and says when a language can't", () => {
    const r = newRequest({ url: "https://api.test/x" });
    r.auth = { ...defaultAuth("digest"), username: "bob", password: "pw" };
    const digest = buildRequest(r, { ctx: {} });
    expect(generateSnippet("curl", digest)).toContain("--digest \\\n  --user 'bob:pw'");
    expect(generateSnippet("httpie", digest)).toContain("--auth-type=digest");
    expect(snippetSigns("python-requests", digest)).toBe(false);
    r.auth = { ...defaultAuth("awsv4"), aws: { accessKey: "AK", secretKey: "SK", sessionToken: "", region: "eu-west-1", service: "execute-api" } };
    const aws = buildRequest(r, { ctx: {} });
    expect(generateSnippet("curl", aws)).toContain("--aws-sigv4 'aws:amz:eu-west-1:execute-api'");
    expect(snippetSigns("httpie", aws)).toBe(false);
    expect(snippetSigns("go", buildRequest(newRequest({ url: "https://api.test" }), { ctx: {} }))).toBe(true);
  });
});
