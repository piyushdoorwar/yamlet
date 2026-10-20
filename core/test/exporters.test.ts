import { describe, expect, it } from "vitest";
import { exportCollectionV2, exportEnvironmentJson, exportFileName, V21_COLLECTION_SCHEMA } from "../src/exporters.js";
import { detectImportFormat, importCollectionV2, importEnvironmentJson } from "../src/importers.js";
import { defaultAuth, defaultBody, newCollection, newEnvironment, newFolder, newRequest } from "../src/models.js";

function sample() {
  const c = newCollection({
    name: "Shop API",
    description: "Orders and users",
    auth: { ...defaultAuth("bearer"), token: "{{token}}" },
    preRequestScript: "console.log('pre')",
    variables: [
      { key: "baseUrl", value: "https://shop.test", enabled: true },
      { key: "token", value: "s3cret", enabled: true, local: true, secret: true },
    ],
  });
  const create = newRequest({
    name: "Create order",
    method: "POST",
    url: "{{baseUrl}}/orders/:shop",
    order: 2000,
    headers: [{ key: "X-Trace", value: "1", enabled: false }],
    queryParams: [{ key: "dry", value: "true", enabled: true }],
    pathVariables: [{ key: "shop", value: "eu" }],
    body: { ...defaultBody(), type: "json", raw: '{"qty":2}' },
    postResponseScript: "pm.test('ok', () => pm.response.to.have.status(201));",
    examples: [{ id: "e1", name: "Created", status: 201, headers: [{ key: "Content-Type", value: "application/json", enabled: true }], body: '{"id":1}' }],
  });
  const upload = newRequest({
    name: "Upload",
    method: "PUT",
    url: "{{baseUrl}}/files",
    order: 1000,
    auth: { ...defaultAuth("apikey"), apiKeyName: "X-Key", apiKeyValue: "k", apiKeyIn: "header" },
    body: { ...defaultBody(), type: "form-data", fields: [{ key: "file", value: "files/a.png", enabled: true, isFile: true }, { key: "note", value: "hi", enabled: true }] },
  });
  const folder = newFolder({ name: "Orders", order: 1000, requests: [create] });
  c.folders = [folder];
  c.requests = [upload];
  return c;
}

describe("collection export", () => {
  it("keeps request variables and splits multi-file form rows on import", () => {
    const c = newCollection({ name: "V" });
    c.requests.push(newRequest({ name: "r", variables: [{ key: "id", value: "7", enabled: true }] }));
    const back = importCollectionV2(JSON.parse(JSON.stringify(exportCollectionV2(c))));
    expect(back.requests[0].variables).toEqual([{ key: "id", value: "7", enabled: true }]);

    const multi = importCollectionV2({
      info: { name: "M" },
      item: [{ name: "up", request: { method: "POST", url: "https://h/u", body: { mode: "formdata", formdata: [{ key: "f", type: "file", src: ["a.txt", "b.txt"] }] } } }],
    });
    expect(multi.requests[0].body.fields).toEqual([
      { key: "f", value: "a.txt", enabled: true, isFile: true },
      { key: "f", value: "b.txt", enabled: true, isFile: true },
    ]);
  });

  it("round-trips through the importer", () => {
    const exported = exportCollectionV2(sample());
    const text = JSON.stringify(exported);
    expect((exported as { info: { schema: string } }).info.schema).toBe(V21_COLLECTION_SCHEMA);
    expect(detectImportFormat(text)).toBe("collection-v2");
    const back = importCollectionV2(JSON.parse(text));
    expect(back.name).toBe("Shop API");
    expect(back.auth).toMatchObject({ type: "bearer", token: "{{token}}" });
    expect(back.preRequestScript).toBe("console.log('pre')");

    const create = back.folders[0].requests[0];
    expect(back.folders[0].name).toBe("Orders");
    expect(create).toMatchObject({ name: "Create order", method: "POST", url: "{{baseUrl}}/orders/:shop", auth: { type: "inherit" } });
    expect(create.queryParams).toEqual([{ key: "dry", value: "true", enabled: true }]);
    expect(create.headers).toEqual([{ key: "X-Trace", value: "1", enabled: false }]);
    expect(create.pathVariables).toEqual([{ key: "shop", value: "eu" }]);
    expect(create.body).toMatchObject({ type: "json", raw: '{"qty":2}' });
    expect(create.postResponseScript).toContain("pm.test('ok'");
    expect(create.examples[0]).toMatchObject({ name: "Created", status: 201, body: '{"id":1}' });

    const upload = back.requests[0];
    expect(upload.auth).toMatchObject({ type: "apikey", apiKeyName: "X-Key", apiKeyValue: "k", apiKeyIn: "header" });
    expect(upload.body.fields).toEqual([
      { key: "file", value: "files/a.png", enabled: true, isFile: true },
      { key: "note", value: "hi", enabled: true },
    ]);
  });

  it("orders folders and requests together and blanks local values unless asked", () => {
    const exported = exportCollectionV2(sample()) as { item: { name: string }[]; variable: { key: string; value: string }[] };
    expect(exported.item.map((i) => i.name)).toEqual(["Orders", "Upload"]);
    expect(exported.variable.find((v) => v.key === "token")?.value).toBe("");
    const withLocal = exportCollectionV2(sample(), { includeLocal: true }) as typeof exported;
    expect(withLocal.variable.find((v) => v.key === "token")?.value).toBe("s3cret");
  });
});

describe("environment export", () => {
  it("round-trips and keeps secret and disabled flags", () => {
    const env = newEnvironment({
      name: "Staging",
      variables: [
        { key: "host", value: "stg.test", enabled: true },
        { key: "pw", value: "x", enabled: false, secret: true },
      ],
    });
    const back = importEnvironmentJson(JSON.parse(JSON.stringify(exportEnvironmentJson(env))));
    expect(back.name).toBe("Staging");
    expect(back.variables).toEqual([
      { key: "host", value: "stg.test", enabled: true },
      { key: "pw", value: "x", enabled: false, secret: true },
    ]);
  });

  it("names files safely", () => {
    expect(exportFileName("A/B: test", "collection")).toBe("A-B- test.collection.json");
    expect(exportFileName("", "environment")).toBe("environment.environment.json");
  });
});
