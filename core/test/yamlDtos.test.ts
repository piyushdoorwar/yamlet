import { describe, expect, it } from "vitest";
import { defaultAuth, newCollection, newRequest, type YamletRequest } from "../src/models.js";
import {
  applyCollectionDefinition,
  applyCollectionMetadata,
  applyFolderMetadata,
  collectionToYaml,
  deriveEnvironmentName,
  deriveNameFromFile,
  environmentFromYaml,
  environmentToYaml,
  folderToYaml,
  globalsFromYaml,
  globalsToYaml,
  loadYaml,
  readAuth,
  requestFromYaml,
  requestToYaml,
  writeAuth,
} from "../src/yamlDtos.js";
import { newFolder } from "../src/models.js";

const roundTrip = (r: YamletRequest) => requestFromYaml(requestToYaml(r), "/tmp/x.yaml");

describe("request files", () => {
  it("round-trips the core fields", () => {
    const r = newRequest({
      id: "req-1",
      name: "Get Users",
      url: "{{baseUrl}}/users",
      queryParams: [{ key: "page", value: "1", description: "Page number", enabled: true }],
      headers: [{ key: "Accept", value: "application/json", enabled: true }],
      auth: { ...defaultAuth("bearer"), token: "secret" },
      body: { ...newRequest().body, type: "json", raw: '{"a":1}' },
    });
    const back = roundTrip(r);
    expect(back.id).toBe("req-1");
    expect(back.name).toBe("Get Users");
    expect(back.method).toBe("GET");
    expect(back.url).toBe("{{baseUrl}}/users");
    expect(back.queryParams).toEqual([{ key: "page", value: "1", description: "Page number", enabled: true }]);
    expect(back.headers).toEqual([{ key: "Accept", value: "application/json", enabled: true }]);
    expect(back.auth.type).toBe("bearer");
    expect(back.auth.token).toBe("secret");
    expect(back.body.type).toBe("json");
    expect(back.body.raw).toBe('{"a":1}');
    expect(back.sourceFilePath).toBe("/tmp/x.yaml");
  });

  it("round-trips order and disabled rows", () => {
    const r = newRequest({ name: "Second", order: 3, headers: [{ key: "X", value: "1", enabled: false }] });
    const yaml = requestToYaml(r);
    expect(yaml).toContain("order: 3");
    const back = roundTrip(r);
    expect(back.order).toBe(3);
    expect(back.headers[0].enabled).toBe(false);
  });

  it("uses camelCase keys and lowercase auth names", () => {
    const yaml = requestToYaml(newRequest({ method: "POST", auth: defaultAuth("none"), queryParams: [{ key: "q", value: "1", enabled: true }] }));
    expect(yaml).toContain("queryParams:");
    expect(yaml).toContain("type: noauth");
  });

  it("omits auth when inheriting and stays lean", () => {
    const yaml = requestToYaml(newRequest({ name: "Sample", url: "https://api.example.com" }));
    expect(yaml).not.toContain("auth:");
    expect(yaml).not.toContain("body:");
    expect(yaml).not.toContain("settings:");
    expect(yaml).not.toContain("headers:");
    expect(roundTrip(newRequest()).auth.type).toBe("inherit");
  });

  it("round-trips scripts by phase", () => {
    const back = roundTrip(newRequest({ preRequestScript: "let a = 1;", postResponseScript: "pm.environment.set('id', 5);" }));
    expect(back.preRequestScript).toBe("let a = 1;");
    expect(back.postResponseScript).toBe("pm.environment.set('id', 5);");
  });

  it("round-trips settings, examples, secrets, description and new body types", () => {
    const r = newRequest({
      description: "Lists things",
      settings: { timeoutMs: 1500, followRedirects: false, skipSslVerification: true },
      examples: [{ id: "ex1", name: "OK", status: 200, headers: [{ key: "Content-Type", value: "application/json", enabled: true }], body: "{}", contentType: "application/json" }],
      variables: [{ key: "token", value: "s3cret", enabled: true, secret: true }],
      body: { ...newRequest().body, type: "graphql", graphqlQuery: "{ me { id } }", graphqlVariables: '{"a":1}' },
    });
    const yaml = requestToYaml(r);
    expect(yaml).toContain("type: secret");
    const back = roundTrip(r);
    expect(back.description).toBe("Lists things");
    expect(back.settings).toEqual({ timeoutMs: 1500, followRedirects: false, skipSslVerification: true });
    expect(back.examples).toEqual(r.examples);
    expect(back.variables[0].secret).toBe(true);
    expect(back.body.type).toBe("graphql");
    expect(back.body.graphqlQuery).toBe("{ me { id } }");
    expect(back.body.graphqlVariables).toBe('{"a":1}');

    for (const type of ["xml", "text", "html"] as const) {
      const b = roundTrip(newRequest({ body: { ...newRequest().body, type, raw: "<a/>" } }));
      expect(b.body.type).toBe(type);
      expect(b.body.raw).toBe("<a/>");
    }
    const bin = roundTrip(newRequest({ body: { ...newRequest().body, type: "binary", binaryFile: "files/a.png" } }));
    expect(bin.body).toMatchObject({ type: "binary", binaryFile: "files/a.png" });
  });

  it("round-trips form fields including files", () => {
    const back = roundTrip(
      newRequest({
        body: {
          ...newRequest().body,
          type: "form-data",
          fields: [
            { key: "domain", value: "example", enabled: true },
            { key: "file", value: "@upload.txt", enabled: true, isFile: true },
          ],
        },
      }),
    );
    expect(back.body.fields).toEqual([
      { key: "domain", value: "example", enabled: true },
      { key: "file", value: "upload.txt", enabled: true, isFile: true },
    ]);
  });

  it("reads the legacy skip-SSL flags", () => {
    expect(requestFromYaml("skipSslVerification: true\n").settings.skipSslVerification).toBe(true);
    expect(requestFromYaml("ssl:\n  verify: false\n").settings.skipSslVerification).toBe(true);
    expect(requestFromYaml("ssl:\n  skipVerification: true\n").settings.skipSslVerification).toBe(true);
  });

  it("reads protocolProfileBehavior and drops it on save", () => {
    const original = "url: https://a.test\nprotocolProfileBehavior:\n  followRedirects: false\n  strictSSL: false\n";
    const r = requestFromYaml(original);
    expect(r.settings).toMatchObject({ followRedirects: false, skipSslVerification: true });
    // Turning redirects back on must stick: the old key is not written back to override it.
    r.settings = { ...r.settings, followRedirects: true };
    const saved = requestToYaml(r, original);
    expect(saved).not.toContain("protocolProfileBehavior");
    expect(requestFromYaml(saved).settings.followRedirects).toBe(true);
  });

  it("keeps numeric-looking values as written", () => {
    const r = requestFromYaml("queryParams:\n  - key: v\n    value: 1.0\n  - key: h\n    value: 0x10\n");
    expect(r.queryParams.map((q) => q.value)).toEqual(["1.0", "0x10"]);
  });

  it("defaults for an empty file", () => {
    const r = requestFromYaml("");
    expect(r.method).toBe("GET");
    expect(r.id).toBeTruthy();
  });

  it("preserves unknown top-level keys but not removed modeled ones", () => {
    const original = "$kind: http-request\nname: Existing\nmethod: GET\nurl: https://example.com\nheaders:\n  - key: A\n    value: b\ntests:\n  - type: http\n    code: pm.test('kept', () => {});\n";
    const r = requestFromYaml(original);
    r.name = "Updated";
    r.headers = [];
    const saved = requestToYaml(r, original);
    expect(saved).toContain("$kind: http-request");
    expect(saved).toContain("tests:");
    expect(saved).toContain("Updated");
    expect(saved).not.toContain("headers:");
  });
});

describe("imported formats", () => {
  it("reads environments with values and derives names from filenames", () => {
    const env = environmentFromYaml("name: api_local\nvalues:\n  - key: base_url\n    value: 'http://localhost:5444/'\n  - key: token\n    value: ''\n");
    expect(env.name).toBe("api_local");
    expect(env.variables).toHaveLength(2);
    expect(env.variables[0]).toEqual({ key: "base_url", value: "http://localhost:5444/", enabled: true });
    expect(environmentFromYaml("values: []\n", "/x/staging.environment.yaml").name).toBe("staging");
    expect(deriveEnvironmentName("/x/dev.yaml")).toBe("dev");
  });

  it("treats disabled: true as a disabled row", () => {
    const r = requestFromYaml('method: GET\nurl: "{{base_url}}api/items"\nqueryParams:\n  - key: PageSize\n    value: "10"\n    disabled: true\n  - key: Search\n    value: term\n');
    expect(r.queryParams.map((q) => q.enabled)).toEqual([false, true]);
  });

  it("reads scalar body content as raw", () => {
    const r = requestFromYaml('method: POST\nbody:\n  type: json\n  content: |-\n    {"a": 1}\n');
    expect(r.body.type).toBe("json");
    expect(r.body.raw).toContain('"a": 1');
  });

  it("reads list content for form bodies", () => {
    const r = requestFromYaml(
      '$kind: http-request\nmethod: POST\nurl: "{{base_url}}api/documents"\nbody:\n  type: formdata\n  content:\n    - type: file\n      key: file\n      src:\n        - upload.txt\n    - type: text\n      key: domain\n      value: example\n',
    );
    expect(r.method).toBe("POST");
    expect(r.body.type).toBe("form-data");
    expect(r.body.raw).toBe("");
    expect(r.body.fields).toContainEqual({ key: "file", value: "upload.txt", enabled: true, isFile: true });
    expect(r.body.fields).toContainEqual({ key: "domain", value: "example", enabled: true });
    const urlenc = requestFromYaml("body:\n  type: x-www-form-urlencoded\n  content:\n    - key: a\n      value: b\n");
    expect(urlenc.body).toMatchObject({ type: "urlencoded", fields: [{ key: "a", value: "b", enabled: true }] });
  });

  it("reads headers from a map or a list", () => {
    const map = requestFromYaml("headers:\n  Content-Type: application/json\n  Accept: application/json\n");
    expect(map.headers).toHaveLength(2);
    expect(map.headers).toContainEqual({ key: "Content-Type", value: "application/json", enabled: true });
    const list = requestFromYaml("headers:\n  - key: Accept\n    value: application/json\n    enabled: true\n");
    expect(list.headers).toEqual([{ key: "Accept", value: "application/json", enabled: true }]);
  });

  it("derives names from request filenames", () => {
    expect(deriveNameFromFile("/x/Get All.request.yaml")).toBe("Get All");
    expect(deriveNameFromFile("/x/Health.yaml")).toBe("Health");
    expect(requestFromYaml("method: GET\n", "/x/Get All.request.yaml").name).toBe("Get All");
  });

  it("classifies imported script types by phase", () => {
    const r = requestFromYaml("scripts:\n  - type: http:beforeRequest\n    code: console.log('before');\n  - type: http:afterResponse\n    code: pm.test('ok', () => {});\n");
    expect(r.preRequestScript).toContain("before");
    expect(r.postResponseScript).toContain("pm.test");
  });

  it("reads a definition file with map variables, oauth2 auth list and scripts", () => {
    const yaml = [
      "$kind: collection",
      "variables:",
      '  m2m_clientId: "abc"',
      '  accessToken: ""',
      "scripts:",
      "  - type: http:beforeRequest",
      "    code: console.log('pre');",
      "  - type: http:afterResponse",
      "    code: pm.test('ok', () => {});",
      "auth:",
      "  - id: x",
      "    type: oauth2",
      "    credentials:",
      "      accessTokenUrl: https://issuer/oauth2/token",
      '      clientId: "{{m2m_clientId}}"',
      '      clientSecret: "{{secret}}"',
      "      scope: api/read",
      "      grant_type: client_credentials",
      "      addTokenTo: header",
      "      client_authentication: header",
    ].join("\n");
    const c = newCollection();
    applyCollectionDefinition(c, loadYaml(yaml));
    expect(c.auth.type).toBe("oauth2");
    expect(c.auth.oauth2).toMatchObject({
      grantType: "client_credentials",
      accessTokenUrl: "https://issuer/oauth2/token",
      clientId: "{{m2m_clientId}}",
      scope: "api/read",
      addTokenTo: "header",
      clientAuthentication: "basic",
    });
    expect(c.variables).toContainEqual({ key: "m2m_clientId", value: "abc", enabled: true });
    expect(c.preRequestScript).toContain("console.log('pre')");
    expect(c.postResponseScript).toContain("pm.test");
  });

  it("reads the legacy collection v2.1 metadata shape", () => {
    const yaml = [
      "info:",
      "  _exporter_id: legacy-1",
      "  name: Legacy API",
      "variable:",
      "  - key: base",
      "    value: http://x",
      "  - key: off",
      "    value: y",
      "    disabled: true",
      "event:",
      "  - listen: prerequest",
      "    script:",
      "      exec:",
      "        - console.log(1);",
      "        - console.log(2);",
      "auth:",
      "  type: bearer",
      "  bearer:",
      "    - key: token",
      "      value: tok",
    ].join("\n");
    const c = newCollection();
    applyCollectionMetadata(c, loadYaml(yaml));
    expect(c.id).toBe("legacy-1");
    expect(c.name).toBe("Legacy API");
    expect(c.variables).toEqual([
      { key: "base", value: "http://x", enabled: true },
      { key: "off", value: "y", enabled: false },
    ]);
    expect(c.preRequestScript).toBe("console.log(1);\nconsole.log(2);");
    expect(c.auth).toMatchObject({ type: "bearer", token: "tok" });

    // Saving migrates to the native shape and drops the legacy keys.
    const saved = collectionToYaml(c, yaml);
    expect(saved).not.toContain("info:");
    expect(saved).not.toContain("variable:\n");
    expect(saved).toContain("variables:");
  });

  it("reads older object-form credentials", () => {
    expect(readAuth({ type: "basic", basic: { username: "u", password: "p" } })).toMatchObject({ type: "basic", username: "u", password: "p" });
    expect(readAuth({ type: "apikey", apikey: [{ key: "key", value: "X-Key" }, { key: "value", value: "v" }, { key: "in", value: "query" }] })).toMatchObject({
      apiKeyName: "X-Key",
      apiKeyValue: "v",
      apiKeyIn: "query",
    });
  });
});

describe("collections, folders, environments, globals", () => {
  it("round-trips collection metadata", () => {
    const c = newCollection({
      id: "col-1",
      name: "My API",
      description: "About",
      auth: { ...defaultAuth("bearer"), token: "{{token}}" },
      variables: [{ key: "baseUrl", value: "https://api.example.com", enabled: true }],
      preRequestScript: "pre();",
    });
    const back = newCollection();
    applyCollectionMetadata(back, loadYaml(collectionToYaml(c)));
    expect(back).toMatchObject({ id: "col-1", name: "My API", description: "About", preRequestScript: "pre();" });
    expect(back.auth).toMatchObject({ type: "bearer", token: "{{token}}" });
    expect(back.variables).toEqual(c.variables);
  });

  it("round-trips auth types", () => {
    const apikey = { ...defaultAuth("apikey"), apiKeyName: "X-Api-Key", apiKeyValue: "k", apiKeyIn: "query" as const };
    expect(readAuth(writeAuth(apikey))).toMatchObject({ type: "apikey", apiKeyIn: "query", apiKeyName: "X-Api-Key" });
    expect(readAuth(writeAuth({ ...defaultAuth("cookie"), cookie: "session={{sid}}" }))).toMatchObject({ type: "cookie", cookie: "session={{sid}}" });
    const oauth = { ...defaultAuth("oauth2") };
    oauth.oauth2 = { ...oauth.oauth2, grantType: "password", username: "u", addTokenTo: "query", clientAuthentication: "body", challengeAlgorithm: "plain", headerPrefix: "Token" };
    expect(readAuth(writeAuth(oauth)).oauth2).toEqual(oauth.oauth2);
  });

  it("round-trips folder metadata", () => {
    const f = newFolder({ id: "f1", name: "users", order: 2, description: "Users" });
    const back = newFolder({ name: "from-dir" });
    applyFolderMetadata(back, loadYaml(folderToYaml(f)));
    expect(back).toMatchObject({ id: "f1", name: "users", order: 2, description: "Users" });
  });

  it("writes environments natively and round-trips them", () => {
    const yaml = environmentToYaml({ id: "env-1", name: "Local", variables: [{ key: "baseUrl", value: "http://localhost:5000", enabled: true }] });
    expect(yaml).toContain("variables:");
    expect(yaml).not.toContain("values:");
    const back = environmentFromYaml(yaml);
    expect(back.name).toBe("Local");
    expect(back.variables[0].value).toBe("http://localhost:5000");
  });

  it("drops exporter bookkeeping keys and the values alias when saving an imported environment", () => {
    const original = "name: x\nvalues:\n  - key: a\n    value: b\n_exporter_variable_scope: environment\ncolor: blue\n";
    const saved = environmentToYaml(environmentFromYaml(original), original);
    expect(saved).not.toContain("values:");
    expect(saved).not.toContain("_exporter_variable_scope");
    expect(saved).toContain("color: blue");
  });

  it("round-trips globals", () => {
    expect(globalsFromYaml(globalsToYaml([{ key: "appName", value: "Yamlet", enabled: true }]))).toEqual([{ key: "appName", value: "Yamlet", enabled: true }]);
  });
});
