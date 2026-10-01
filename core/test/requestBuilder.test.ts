import { describe, expect, it } from "vitest";
import { generateSnippet, SNIPPET_LANGUAGES } from "../src/codegen.js";
import { defaultAuth, newCollection, newRequest, YAMLET_USER_AGENT } from "../src/models.js";
import { applyPathVariables, buildRequest } from "../src/requestBuilder.js";

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

  it("always sends the Yamlet user agent and skips disabled headers", () => {
    const r = newRequest({
      url: "https://x.test",
      headers: [
        { key: "User-Agent", value: "Other/2.0", enabled: true },
        { key: "X-On", value: "1", enabled: true },
        { key: "X-Off", value: "2", enabled: false },
      ],
    });
    const b = buildRequest(r, { ctx: {} });
    expect(b.headers.filter((h) => h.key.toLowerCase() === "user-agent")).toEqual([{ key: "User-Agent", value: YAMLET_USER_AGENT, enabled: true }]);
    expect(header(b, "X-On")).toBe("1");
    expect(header(b, "X-Off")).toBeUndefined();
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
    expect(SNIPPET_LANGUAGES.map((l) => l.id)).toEqual(["curl", "http", "javascript-fetch", "node-axios", "python-requests", "go", "csharp-httpclient", "java-okhttp", "php-curl", "powershell", "ruby"]);
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
    expect(generateSnippet("curl", samples[0])).toBe("curl --location 'https://api.test/users?x=1' \\\n  --header 'User-Agent: Yamlet/1.0.0'");
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
