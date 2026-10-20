import { describe, expect, it } from "vitest";
import { bundleExternalRefs, detectImportFormat, importCollectionV2, importEnvironmentJson, importHar, importOpenApi } from "../src/importers.js";
import { effectiveAuth } from "../src/requestBuilder.js";

const v21 = {
  info: { name: "Shop API", description: "All the things", schema: "https://schema.example/json/collection/v2.1.0/collection.json" },
  variable: [{ key: "baseUrl", value: "https://shop.test" }, { key: "off", value: "x", disabled: true }],
  auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
  event: [
    { listen: "prerequest", script: { exec: ["console.log('collection pre');"] } },
    { listen: "test", script: { exec: ["pm.test('collection', () => {});"] } },
  ],
  item: [
    {
      name: "Products",
      description: "Product endpoints",
      auth: { type: "apikey", apikey: [{ key: "key", value: "X-Key" }, { key: "value", value: "{{k}}" }, { key: "in", value: "header" }] },
      event: [{ listen: "prerequest", script: { exec: ["console.log('folder pre');"] } }],
      item: [
        {
          name: "List products",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }, { key: "X-Off", value: "1", disabled: true }],
            url: {
              raw: "{{baseUrl}}/products/:category?limit=10&page=2",
              host: ["{{baseUrl}}"],
              path: ["products", ":category"],
              query: [{ key: "limit", value: "10" }, { key: "page", value: "2", disabled: true }],
              variable: [{ key: "category", value: "shoes", description: "Category slug" }],
            },
          },
          event: [{ listen: "test", script: { exec: ["pm.test('ok', () => pm.response.to.have.status(200));"] } }],
          response: [
            { name: "Success", code: 200, status: "OK", header: [{ key: "Content-Type", value: "application/json" }], body: "[]" },
          ],
        },
        {
          name: "Create product",
          request: {
            method: "POST",
            auth: { type: "noauth" },
            header: [{ key: "Content-Type", value: "application/json" }],
            url: "{{baseUrl}}/products",
            body: { mode: "raw", raw: '{"name":"x"}', options: { raw: { language: "json" } } },
          },
        },
      ],
    },
    {
      name: "Upload",
      request: {
        method: "POST",
        url: "{{baseUrl}}/upload",
        body: { mode: "formdata", formdata: [{ key: "file", type: "file", src: ["/tmp/a.png"] }, { key: "note", value: "hi", type: "text" }] },
      },
    },
    {
      name: "Login",
      request: {
        method: "POST",
        url: "{{baseUrl}}/login",
        body: { mode: "urlencoded", urlencoded: [{ key: "user", value: "u" }, { key: "pass", value: "p", disabled: true }] },
        auth: { type: "oauth2", oauth2: [{ key: "accessTokenUrl", value: "https://auth.test/token" }, { key: "grant_type", value: "client_credentials" }, { key: "clientId", value: "cid" }, { key: "addTokenTo", value: "header" }] },
      },
    },
    { name: "GraphQL", request: { method: "POST", url: "{{baseUrl}}/graphql", body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: '{"a":1}' } } } },
    { name: "Binary", request: { method: "PUT", url: "{{baseUrl}}/blob", body: { mode: "file", file: { src: "/tmp/b.bin" } } } },
    { name: "Bare", request: "https://bare.test/x?y=1" },
  ],
};

describe("importCollectionV2", () => {
  it("imports the item tree with folders, requests and metadata", () => {
    const c = importCollectionV2(v21);
    expect(c.name).toBe("Shop API");
    expect(c.description).toBe("All the things");
    expect(c.variables).toEqual([
      { key: "baseUrl", value: "https://shop.test", enabled: true },
      { key: "off", value: "x", enabled: false },
    ]);
    expect(c.auth).toMatchObject({ type: "bearer", token: "{{token}}" });
    expect(c.preRequestScript).toContain("collection pre");
    expect(c.postResponseScript).toContain("pm.test('collection'");
    expect(c.folders.map((f) => f.name)).toEqual(["Products"]);
    expect(c.folders[0].description).toBe("Product endpoints");
    expect(c.requests.map((r) => r.name)).toEqual(["Upload", "Login", "GraphQL", "Binary", "Bare"]);
  });

  it("maps url objects, headers, path variables and examples", () => {
    const imported = importCollectionV2(v21);
    const folder = imported.folders[0];
    const list = folder.requests[0];
    expect(list.method).toBe("GET");
    expect(list.url).toBe("{{baseUrl}}/products/:category");
    expect(list.queryParams).toEqual([
      { key: "limit", value: "10", enabled: true },
      { key: "page", value: "2", enabled: false },
    ]);
    expect(list.pathVariables).toEqual([{ key: "category", value: "shoes", description: "Category slug" }]);
    expect(list.headers[1].enabled).toBe(false);
    expect(list.examples).toMatchObject([{ name: "Success", status: 200, body: "[]", contentType: "application/json" }]);
    // Folder auth and scripts stay on the folder; the request inherits them when sent.
    expect(list.auth.type).toBe("inherit");
    expect(folder.auth).toMatchObject({ type: "apikey", apiKeyName: "X-Key", apiKeyValue: "{{k}}", apiKeyIn: "header" });
    expect(effectiveAuth(list, imported, [folder])).toMatchObject({ type: "apikey", apiKeyName: "X-Key" });
    expect(folder.preRequestScript).toContain("folder pre");
    expect(list.preRequestScript).not.toContain("folder pre");
    expect(list.postResponseScript).toContain("have.status(200)");
  });

  it("maps body modes and auth overrides", () => {
    const c = importCollectionV2(v21);
    const create = c.folders[0].requests[1];
    expect(create.auth.type).toBe("none");
    expect(create.body).toMatchObject({ type: "json", raw: '{"name":"x"}' });
    const [upload, login, gql, bin, bare] = c.requests;
    expect(upload.auth.type).toBe("inherit");
    expect(upload.body.fields).toEqual([
      { key: "file", value: "/tmp/a.png", enabled: true, isFile: true },
      { key: "note", value: "hi", enabled: true },
    ]);
    expect(login.body).toMatchObject({ type: "urlencoded", fields: [{ key: "user", value: "u", enabled: true }, { key: "pass", value: "p", enabled: false }] });
    expect(login.auth.type).toBe("oauth2");
    expect(login.auth.oauth2).toMatchObject({ accessTokenUrl: "https://auth.test/token", grantType: "client_credentials", clientId: "cid" });
    expect(gql.body).toMatchObject({ type: "graphql", graphqlQuery: "{ me { id } }", graphqlVariables: '{"a":1}' });
    expect(bin.body).toMatchObject({ type: "binary", binaryFile: "/tmp/b.bin" });
    expect(bare).toMatchObject({ method: "GET", url: "https://bare.test/x", queryParams: [{ key: "y", value: "1", enabled: true }] });
  });

  it("maps protocolProfileBehavior onto request settings, inherited from collection and folders", () => {
    const c = importCollectionV2({
      info: { name: "Redirects" },
      protocolProfileBehavior: { strictSSL: false },
      item: [
        { name: "Follows", request: "https://a.test" },
        { name: "Stops", protocolProfileBehavior: { followRedirects: false }, request: "https://a.test" },
        {
          name: "Folder",
          protocolProfileBehavior: { followRedirects: false },
          item: [
            { name: "Inherits", request: "https://a.test" },
            { name: "Overrides", protocolProfileBehavior: { followRedirects: true, strictSSL: true }, request: "https://a.test" },
          ],
        },
      ],
    });
    const [follows, stops] = c.requests;
    const [inherits, overrides] = c.folders[0].requests;
    expect(follows.settings).toMatchObject({ followRedirects: true, skipSslVerification: true });
    expect(stops.settings.followRedirects).toBe(false);
    expect(inherits.settings.followRedirects).toBe(false);
    expect(overrides.settings).toMatchObject({ followRedirects: true, skipSslVerification: false });
  });

  it("detects formats", () => {
    expect(detectImportFormat(JSON.stringify(v21))).toBe("collection-v2");
    expect(detectImportFormat(JSON.stringify({ collection: v21 }))).toBe("collection-v2");
    expect(detectImportFormat(JSON.stringify({ name: "e", values: [] }))).toBe("environment");
    expect(detectImportFormat("openapi: 3.0.0\ninfo:\n  title: x\npaths: {}\n")).toBe("openapi");
    expect(detectImportFormat('{"swagger":"2.0"}')).toBe("openapi");
    expect(detectImportFormat("curl https://x.test")).toBe("curl");
    expect(detectImportFormat("hello world")).toBe("unknown");
    expect(detectImportFormat("")).toBe("unknown");
  });
});

describe("folder variables in a v2.1 collection", () => {
  it("copies them onto the requests inside, nearest and own values winning", () => {
    const c = importCollectionV2({
      info: { name: "F" },
      item: [
        {
          name: "outer",
          variable: [{ key: "a", value: "outer" }, { key: "b", value: "outer" }],
          item: [
            { name: "inner", variable: [{ key: "b", value: "inner" }], item: [{ name: "r", variable: [{ key: "c", value: "own" }], request: { url: "https://h/{{a}}" } }] },
          ],
        },
      ],
    });
    const r = c.folders[0].folders[0].requests[0];
    expect(Object.fromEntries(r.variables.map((v) => [v.key, v.value]))).toEqual({ a: "outer", b: "inner", c: "own" });
  });
});

describe("disabled parts of a v2.1 collection", () => {
  it("comments out disabled scripts and drops a disabled body", () => {
    const c = importCollectionV2({
      info: { name: "D" },
      item: [
        {
          name: "r",
          event: [{ listen: "prerequest", disabled: true, script: { exec: ["pm.environment.set('x', 1);"] } }],
          request: { method: "POST", url: "https://h/r", body: { mode: "raw", raw: "{}", disabled: true } },
        },
      ],
    });
    expect(c.requests[0].preRequestScript).toBe("// Disabled in the imported collection:\n// pm.environment.set('x', 1);");
    expect(c.requests[0].body.type).toBe("none");
  });
});

describe("OpenAPI parameter examples", () => {
  it("repeats exploded array params and reads x-example", () => {
    const c = importOpenApi(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "P", version: "1" },
      paths: {
        "/a": {
          get: {
            parameters: [
              { name: "ids", in: "query", required: true, example: [1, 2] },
              { name: "tags", in: "query", required: true, explode: false, example: ["x", "y"] },
              { name: "f", in: "query", required: true, content: { "application/json": { example: { a: 1 } } } },
            ],
            responses: {},
          },
        },
      },
    }));
    expect(c.requests[0].queryParams.map((q) => `${q.key}=${q.value}`)).toEqual(["ids=1", "ids=2", "tags=x,y", 'f={"a":1}']);
    const s2 = importOpenApi(JSON.stringify({ swagger: "2.0", info: { title: "S", version: "1" }, host: "h", paths: { "/b": { get: { parameters: [{ name: "q", in: "query", type: "string", "x-example": "hi" }], responses: {} } } } }));
    expect(s2.requests[0].queryParams[0].value).toBe("hi");
  });
});

describe("OpenAPI servers and unsupported schemes", () => {
  const doc = (extra: object) =>
    JSON.stringify({ openapi: "3.0.0", info: { title: "R", version: "1" }, paths: { "/a": { get: { responses: {} } } }, ...extra });
  it("resolves a relative server against the import link, or asks for {{host}}", () => {
    expect(importOpenApi(doc({ servers: [{ url: "/v1" }] }), { sourceUrl: "https://api.test/docs/openapi.json" }).variables[0].value).toBe("https://api.test/v1");
    expect(importOpenApi(doc({ servers: [{ url: "v2" }] }), { sourceUrl: "https://api.test/docs/openapi.json" }).variables[0].value).toBe("https://api.test/docs/v2");
    const c = importOpenApi(doc({ servers: [{ url: "/v1" }] }));
    expect(c.variables[0].value).toBe("{{host}}/v1");
    expect(c.description).toMatch(/set \{\{host\}\}/);
    expect(importOpenApi(doc({})).variables[0].value).toBe("{{host}}");
  });

  it("maps digest, notes unsupported schemes, and leaves their operations without auth", () => {
    const c = importOpenApi(doc({
      servers: [{ url: "https://h" }],
      security: [{ key: [] }],
      components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" }, tls: { type: "mutualTLS" }, dig: { type: "http", scheme: "digest" } } },
      paths: { "/m": { get: { security: [{ tls: [] }], responses: {} } }, "/d": { get: { security: [{ dig: [] }], responses: {} } } },
    }));
    const [m, d] = c.requests;
    expect(m.auth.type).toBe("none");
    expect(d.auth.type).toBe("digest");
    expect(c.description).toMatch(/"tls" \(mutualTLS\) isn't supported/);
  });
});

describe("OpenAPI operation security", () => {
  it("leaves operations without security public when there is no global security", () => {
    const c = importOpenApi(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "S", version: "1" },
      servers: [{ url: "https://h" }],
      components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } } },
      paths: { "/secure": { get: { security: [{ key: [] }], responses: {} } }, "/public": { get: { responses: {} } } },
    }));
    const [secure, open] = c.requests.length ? c.requests : c.folders.flatMap((f) => f.requests);
    expect(c.auth.type).toBe("none");
    expect(secure.auth.type).toBe("apikey");
    expect(effectiveAuth(open, c, []).type).toBe("none");
  });
});

describe("importEnvironmentJson", () => {
  it("reads values with enabled flags and secrets", () => {
    const env = importEnvironmentJson({
      id: "x",
      name: "Prod",
      values: [
        { key: "a", value: "1", enabled: true },
        { key: "b", value: "2", enabled: false },
        { key: "s", value: "3", type: "secret", enabled: true },
      ],
    });
    expect(env.name).toBe("Prod");
    expect(env.variables).toEqual([
      { key: "a", value: "1", enabled: true },
      { key: "b", value: "2", enabled: false },
      { key: "s", value: "3", enabled: true, secret: true },
    ]);
    expect(() => importEnvironmentJson({ name: "x" })).toThrow();
  });
});

const openApi3 = `
openapi: 3.0.3
info:
  title: Pets
  description: A pet store
servers:
  - url: https://{env}.pets.test/v1
    variables:
      env:
        default: api
tags:
  - name: pets
    description: Everything about pets
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
    apiKey:
      type: apiKey
      in: query
      name: key
  schemas:
    Pet:
      type: object
      required: [name]
      properties:
        id: { type: integer, readOnly: true }
        name: { type: string, example: Rex }
        tags: { type: array, items: { type: string } }
        born: { type: string, format: date }
        owner: { $ref: '#/components/schemas/Owner' }
    Owner:
      type: object
      properties:
        email: { type: string, format: email }
  parameters:
    Limit:
      name: limit
      in: query
      schema: { type: integer, default: 20 }
security:
  - bearerAuth: []
paths:
  /pets/{petId}:
    parameters:
      - name: petId
        in: path
        required: true
        schema: { type: string, example: p1 }
    get:
      tags: [pets]
      summary: Get a pet
      operationId: getPet
      responses:
        '200':
          description: OK
          content:
            application/json:
              example: { id: 1, name: Rex }
    delete:
      tags: [pets]
      operationId: deletePet
      security:
        - apiKey: []
      responses:
        '204': { description: gone }
  /pets:
    get:
      tags: [pets]
      summary: List pets
      parameters:
        - $ref: '#/components/parameters/Limit'
        - name: X-Request-Id
          in: header
          required: true
          schema: { type: string }
    post:
      tags: [pets]
      summary: Create a pet
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
  /upload:
    post:
      summary: Upload
      security: []
      requestBody:
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                file: { type: string, format: binary }
                note: { type: string }
`;

describe("importOpenApi", () => {
  it("imports OpenAPI 3 with servers, tags, params, bodies and security", () => {
    const c = importOpenApi(openApi3);
    expect(c.name).toBe("Pets");
    expect(c.variables[0]).toEqual({ key: "baseUrl", value: "https://{{env}}.pets.test/v1", enabled: true });
    expect(c.variables[1]).toEqual({ key: "env", value: "api", enabled: true });
    expect(c.auth).toMatchObject({ type: "bearer", token: "{{bearerToken}}" });
    expect(c.variables.some((v) => v.key === "bearerToken" && v.secret)).toBe(true);
    expect(c.folders.map((f) => f.name)).toEqual(["pets"]);
    expect(c.folders[0].description).toBe("Everything about pets");

    const [getPet, deletePet, listPets, createPet] = c.folders[0].requests;
    expect(getPet).toMatchObject({ name: "Get a pet", method: "GET", url: "{{baseUrl}}/pets/:petId", pathVariables: [{ key: "petId", value: "p1" }] });
    expect(getPet.examples).toMatchObject([{ status: 200, body: JSON.stringify({ id: 1, name: "Rex" }, null, 2) }]);
    expect(deletePet.name).toBe("deletePet");
    expect(deletePet.auth).toMatchObject({ type: "apikey", apiKeyName: "key", apiKeyIn: "query", apiKeyValue: "{{apiKey}}" });
    expect(listPets.queryParams).toEqual([{ key: "limit", value: "20", enabled: false }]);
    expect(listPets.headers).toEqual([{ key: "X-Request-Id", value: "", enabled: true }]);
    expect(createPet.body.type).toBe("json");
    expect(JSON.parse(createPet.body.raw)).toEqual({ name: "Rex", tags: ["string"], born: "2024-01-01", owner: { email: "user@example.com" } });

    const upload = c.requests[0];
    expect(upload.auth.type).toBe("none");
    expect(upload.body.type).toBe("form-data");
    expect(upload.body.fields).toEqual([
      { key: "file", value: "", enabled: true, isFile: true },
      { key: "note", value: "string", enabled: true },
    ]);
  });

  it("imports Swagger 2 from JSON", () => {
    const doc = {
      swagger: "2.0",
      info: { title: "Legacy" },
      host: "legacy.test",
      basePath: "/api",
      schemes: ["http"],
      securityDefinitions: { basic: { type: "basic" }, oauth: { type: "oauth2", flow: "application", tokenUrl: "https://legacy.test/token", scopes: { read: "r", write: "w" } } },
      security: [{ oauth: ["read"] }],
      paths: {
        "/items/{id}": {
          put: {
            operationId: "updateItem",
            parameters: [
              { name: "id", in: "path", required: true, type: "string" },
              { name: "body", in: "body", schema: { type: "object", properties: { n: { type: "number" } } } },
            ],
            responses: { "200": { description: "ok", examples: { "application/json": { n: 1 } } } },
          },
        },
        "/form": { post: { consumes: ["multipart/form-data"], parameters: [{ name: "f", in: "formData", type: "file" }, { name: "t", in: "formData", type: "string", default: "x" }] } },
      },
    };
    const c = importOpenApi(JSON.stringify(doc));
    expect(c.variables[0].value).toBe("http://legacy.test/api");
    expect(c.auth.type).toBe("oauth2");
    expect(c.auth.oauth2).toMatchObject({ grantType: "client_credentials", accessTokenUrl: "https://legacy.test/token", scope: "read write", clientId: "{{clientId}}" });
    const [put, form] = c.requests;
    expect(put).toMatchObject({ name: "updateItem", method: "PUT", url: "{{baseUrl}}/items/:id" });
    expect(JSON.parse(put.body.raw)).toEqual({ n: 0 });
    expect(put.examples[0]).toMatchObject({ status: 200, contentType: "application/json" });
    expect(form.body.type).toBe("form-data");
    expect(form.body.fields).toEqual([
      { key: "f", value: "", enabled: true, isFile: true },
      { key: "t", value: "x", enabled: true },
    ]);
  });

  it("rejects non-OpenAPI input", () => {
    expect(() => importOpenApi("{}")).toThrow();
    expect(() => importOpenApi("not: [valid")).toThrow();
  });
});

describe("OpenAPI 3.2 query operations", () => {
  it("imports a query operation as a QUERY request", async () => {
    const { importOpenApi } = await import("../src/importers.js");
    const c = importOpenApi(JSON.stringify({ openapi: "3.2.0", info: { title: "Search", version: "1" }, paths: { "/items": { query: { summary: "Search items" } } } }));
    const all = [...c.requests, ...c.folders.flatMap((f) => f.requests)];
    expect(all.map((r) => r.method)).toContain("QUERY");
  });
});

describe("importHar", () => {
  const har = {
    log: {
      version: "1.2",
      entries: [
        {
          request: {
            method: "GET",
            url: "https://api.test/users?page=2&q=a%20b",
            headers: [
              { name: ":authority", value: "api.test" },
              { name: "Accept", value: "application/json" },
              { name: "Host", value: "api.test" },
              { name: "Authorization", value: "Bearer x" },
            ],
          },
        },
        { request: { method: "post", url: "https://api.test/users", headers: [{ name: "Content-Type", value: "application/json" }], postData: { mimeType: "application/json", text: '{"name":"Ada"}' } } },
        { request: { method: "POST", url: "https://api.test/login", headers: [], postData: { mimeType: "application/x-www-form-urlencoded", params: [{ name: "user", value: "ada" }] } } },
        {
          request: {
            method: "POST",
            url: "https://api.test/upload",
            headers: [{ name: "Content-Type", value: "multipart/form-data; boundary=x" }],
            postData: { mimeType: "multipart/form-data; boundary=x", params: [{ name: "file", fileName: "a.png" }, { name: "note", value: "hi" }] },
          },
        },
      ],
    },
  };

  it("is detected and becomes one request per entry", () => {
    expect(detectImportFormat(JSON.stringify(har))).toBe("har");
    const c = importHar(har, "Session");
    expect(c.name).toBe("Session");
    expect(c.requests.map((r) => r.name)).toEqual(["GET /users", "POST /users", "POST /login", "POST /upload"]);
    const [list, create, login, upload] = c.requests;
    expect(list.url).toBe("https://api.test/users");
    expect(list.queryParams).toEqual([
      { key: "page", value: "2", enabled: true },
      { key: "q", value: "a%20b", enabled: true },
    ]);
    expect(list.headers.map((h) => h.key)).toEqual(["Accept", "Authorization"]);
    expect(create.body).toMatchObject({ type: "json", raw: '{"name":"Ada"}' });
    expect(login.body).toMatchObject({ type: "urlencoded", fields: [{ key: "user", value: "ada", enabled: true }] });
    expect(upload.body.type).toBe("form-data");
    expect(upload.body.fields).toEqual([
      { key: "file", value: "a.png", enabled: true, isFile: true },
      { key: "note", value: "hi", enabled: true },
    ]);
    expect(upload.headers).toEqual([]);
  });
});

describe("OpenAPI refs into other files", () => {
  it("fetches them relative to the spec and follows them", async () => {
    const files: Record<string, string> = {
      "https://specs.test/api/schemas/user.yaml": "User:\n  type: object\n  properties:\n    id: { $ref: '../common.yaml#/Id' }\n    home: { $ref: '#/Address' }\nAddress:\n  type: object\n  properties:\n    city: { type: string, example: Oslo }\n",
      "https://specs.test/api/common.yaml": "Id: { type: integer, example: 7 }\n",
    };
    const fetched: string[] = [];
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Users", version: "1" },
      paths: { "/users": { post: { requestBody: { content: { "application/json": { schema: { $ref: "schemas/user.yaml#/User" } } } } } } },
    });
    const bundled = await bundleExternalRefs(spec, "https://specs.test/api/openapi.json", async (u) => {
      fetched.push(u);
      if (!(u in files)) throw new Error("404");
      return files[u];
    });
    expect(fetched).toEqual(["https://specs.test/api/schemas/user.yaml", "https://specs.test/api/common.yaml"]);
    const c = importOpenApi(bundled);
    const body = JSON.parse(c.requests[0]?.body.raw ?? c.folders[0].requests[0].body.raw);
    expect(body).toEqual({ id: 7, home: { city: "Oslo" } });
  });
});
