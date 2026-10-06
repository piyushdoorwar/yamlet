import { describe, expect, it } from "vitest";
import { detectImportFormat, importCollectionV2, importEnvironmentJson, importOpenApi } from "../src/importers.js";

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
    const list = importCollectionV2(v21).folders[0].requests[0];
    expect(list.method).toBe("GET");
    expect(list.url).toBe("{{baseUrl}}/products/:category");
    expect(list.queryParams).toEqual([
      { key: "limit", value: "10", enabled: true },
      { key: "page", value: "2", enabled: false },
    ]);
    expect(list.pathVariables).toEqual([{ key: "category", value: "shoes", description: "Category slug" }]);
    expect(list.headers[1].enabled).toBe(false);
    expect(list.examples).toMatchObject([{ name: "Success", status: 200, body: "[]", contentType: "application/json" }]);
    // Folder auth is pushed down onto inheriting requests; folder scripts are prepended.
    expect(list.auth).toMatchObject({ type: "apikey", apiKeyName: "X-Key", apiKeyValue: "{{k}}", apiKeyIn: "header" });
    expect(list.preRequestScript).toContain("folder pre");
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
    expect(c.variables[0]).toEqual({ key: "baseUrl", value: "https://api.pets.test/v1", enabled: true });
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
