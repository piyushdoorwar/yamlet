import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCollection, newFolder, newRequest } from "../src/models.js";
import { LocalValuesFile } from "../src/localValues.js";
import { fileSafeName } from "../src/pathNaming.js";
import { WorkspaceStore } from "../src/workspaceStore.js";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "yamlet-ws-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const read = (p: string) => fs.readFile(p, "utf8");
const names = (list: { name: string }[]) => list.map((x) => x.name);

describe("WorkspaceStore", () => {
  it("creates the workspace skeleton under yamlet/ and seeds globals", async () => {
    const store = await WorkspaceStore.create(tmp);
    const root = path.join(tmp, "yamlet");
    expect(store.workspace.rootPath).toBe(root);
    for (const d of ["collections", "environments", "globals"]) expect(existsSync(path.join(root, d))).toBe(true);
    expect(existsSync(path.join(root, "globals", "workspace.globals.yaml"))).toBe(true);
    expect(store.workspace.globals).toContainEqual({ key: "appName", value: "Yamlet", enabled: true });
    expect(store.workspace.name).toBe(path.basename(tmp));
    expect(await WorkspaceStore.isWorkspace(tmp)).toBe(true);
  });

  it("resolves an existing root and refuses to open a missing one", async () => {
    await WorkspaceStore.create(tmp);
    const root = path.join(tmp, "yamlet");
    expect(WorkspaceStore.resolveRoot(root)).toBe(root);
    expect((await WorkspaceStore.open(root)).workspace.rootPath).toBe(root);
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "yamlet-empty-"));
    try {
      await expect(WorkspaceStore.open(empty)).rejects.toThrow();
      expect(existsSync(path.join(empty, "yamlet"))).toBe(false);
      expect(await WorkspaceStore.isWorkspace(empty)).toBe(false);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("writes collection metadata only, never embedded requests", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c = await store.createCollection("My API");
    expect(c.directoryPath!.endsWith(path.join("collections", "My API"))).toBe(true);
    expect(c.filePath).toBe(path.join(c.directoryPath!, ".resources", "definition.yaml"));
    const r = await store.createRequest(c.id, null, { name: "Get Users" });
    expect(r.sourceFilePath).toBe(path.join(c.directoryPath!, "Get Users.request.yaml"));
    const yaml = await read(c.filePath!);
    expect(yaml).toContain("$kind: collection");
    expect(yaml).toContain("name: My API");
    expect(yaml).not.toContain("item:");
    expect(yaml).not.toContain("info:");
    expect(yaml).not.toContain("Get Users");
  });

  it("round-trips requests and folders through disk", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c = await store.createCollection("My API");
    const r = await store.createRequest(c.id, null, { name: "Get Users", url: "https://api.example.com/users" });
    const f = await store.createFolder(c.id, null, "users");
    const sub = await store.createFolder(c.id, f.id, "admins");
    await store.createRequest(c.id, sub.id, { name: "Get Admin", method: "post" });

    const re = await WorkspaceStore.open(tmp);
    const lc = re.workspace.collections[0];
    expect(lc.id).toBe(c.id);
    expect(lc.requests).toHaveLength(1);
    expect(lc.requests[0]).toMatchObject({ id: r.id, name: "Get Users", method: "GET", url: "https://api.example.com/users" });
    expect(names(lc.folders)).toEqual(["users"]);
    expect(lc.folders[0].id).toBe(f.id);
    expect(lc.folders[0].folders[0].requests[0]).toMatchObject({ name: "Get Admin", method: "POST" });
    const found = re.findRequest(lc.folders[0].folders[0].requests[0].id)!;
    expect(found.collection.id).toBe(c.id);
    expect(names(found.folders)).toEqual(["users", "admins"]);
    expect(names(re.findFolder(sub.id)!.folders)).toEqual(["users"]);
  });

  it("persists request and folder order (with tie-break by filename)", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c = await store.createCollection("My API");
    const a = await store.createRequest(c.id, null, { name: "Alpha" });
    await store.createRequest(c.id, null, { name: "Bravo" });
    const ch = await store.createRequest(c.id, null, { name: "Charlie" });
    await store.move("request", ch.id, c.id, null, 0);
    await store.move("request", a.id, c.id, null, 1);
    expect(names(store.findCollection(c.id)!.requests)).toEqual(["Charlie", "Alpha", "Bravo"]);

    const x = await store.createFolder(c.id, null, "Xray");
    await store.createFolder(c.id, null, "Yankee");
    const z = await store.createFolder(c.id, null, "Zulu");
    await store.move("folder", z.id, c.id, null, 0);
    expect(existsSync(path.join(z.directoryPath!, ".resources", "definition.yaml"))).toBe(true);
    expect(store.findCollection(c.id)!.requests.map((r) => r.order)).toEqual([1000, 2000, 3000]);

    const re = await WorkspaceStore.open(tmp);
    expect(names(re.workspace.collections[0].requests)).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(names(re.workspace.collections[0].folders)).toEqual(["Zulu", "Xray", "Yankee"]);
    expect(re.findFolder(x.id)).toBeTruthy();

    // Files without an order fall back to filename order.
    const dir = path.join(tmp, "yamlet", "collections", "plain");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "b.yaml"), "name: B\n");
    await fs.writeFile(path.join(dir, "a.yaml"), "name: A\n");
    const re2 = await WorkspaceStore.open(tmp);
    const plain = re2.workspace.collections.find((col) => col.name === "plain")!;
    expect(names(plain.requests)).toEqual(["A", "B"]);
    // ids derived from paths are stable across reloads
    const re3 = await WorkspaceStore.open(tmp);
    expect(re3.workspace.collections.find((col) => col.name === "plain")!.requests[0].id).toBe(plain.requests[0].id);
  });

  it("saves requests by id, renaming the file when the name changes and preserving unknown keys", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c = await store.createCollection("API");
    const r = await store.createRequest(c.id, null, { name: "First" });
    await fs.appendFile(r.sourceFilePath!, "team: core\n");
    const saved = await store.saveRequest({ ...r, name: "Renamed Thing", url: "https://x.test" });
    expect(path.basename(saved.sourceFilePath!)).toBe("Renamed Thing.request.yaml");
    expect(existsSync(r.sourceFilePath!)).toBe(false);
    const text = await read(saved.sourceFilePath!);
    expect(text).toContain("team: core");
    expect(text).not.toContain("name:");
    expect(text).toContain("url: https://x.test");
    expect(store.findRequest(r.id)!.request.url).toBe("https://x.test");

    // A colliding name gets a numbered file name and keeps its own name inside.
    const other = await store.createRequest(c.id, null, { name: "Other" });
    const s2 = await store.saveRequest({ ...other, name: "Renamed Thing" });
    expect(path.basename(s2.sourceFilePath!)).toBe("Renamed Thing 2.request.yaml");
    expect(await read(s2.sourceFilePath!)).toContain("name: Renamed Thing");
    const again = await store.saveRequest({ ...s2, url: "https://y.test" });
    expect(again.sourceFilePath).toBe(s2.sourceFilePath);
    const re = await WorkspaceStore.open(tmp);
    expect(names(re.findCollection(c.id)!.requests).sort()).toEqual(["Renamed Thing", "Renamed Thing"]);
  });

  it("moves requests and folders across containers on disk", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c1 = await store.createCollection("One");
    const c2 = await store.createCollection("Two");
    const f = await store.createFolder(c1.id, null, "Folder");
    const r = await store.createRequest(c1.id, f.id, { name: "Req" });
    const moved = (await store.move("request", r.id, c2.id, null, 0)) as typeof r;
    expect(path.dirname(moved.sourceFilePath!)).toBe(c2.directoryPath);
    expect(existsSync(moved.sourceFilePath!)).toBe(true);
    await store.move("folder", f.id, c2.id, null, 0);
    expect(store.findFolder(f.id)!.collection.id).toBe(c2.id);
    expect(existsSync(path.join(c2.directoryPath!, "Folder", ".resources", "definition.yaml"))).toBe(true);
    const inner = await store.createFolder(c2.id, f.id, "Inner");
    await expect(store.move("folder", f.id, c2.id, inner.id, 0)).rejects.toThrow(/itself/);

    const re = await WorkspaceStore.open(tmp);
    const two = re.findCollection(c2.id)!;
    expect(names(two.requests)).toEqual(["Req"]);
    expect(names(two.folders)).toEqual(["Folder"]);
    expect(re.findCollection(c1.id)!.folders).toHaveLength(0);
  });

  it("renames, duplicates and deletes collections and folders", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c = await store.createCollection("Orig");
    const f = await store.createFolder(c.id, null, "Sub");
    await store.createRequest(c.id, f.id, { name: "R" });
    const renamed = await store.updateCollection(c.id, { name: "Better Name", variables: [{ key: "a", value: "1", enabled: true }] });
    expect(path.basename(renamed.directoryPath!)).toBe("Better Name");
    expect(store.findRequest(renamed.folders[0].requests[0].id)!.request.sourceFilePath!.startsWith(renamed.directoryPath!)).toBe(true);

    const copy = await store.duplicateCollection(c.id);
    expect(copy.name).toBe("Better Name Copy");
    expect(copy.id).not.toBe(c.id);
    expect(copy.folders[0].requests[0].id).not.toBe(c.folders[0].requests[0].id);

    const fcopy = await store.duplicateFolder(f.id);
    expect(names(store.findCollection(c.id)!.folders)).toEqual(["Sub", "Sub Copy"]);
    const uf = await store.updateFolder(fcopy.id, { name: "Third", description: "desc" });
    expect(path.basename(uf.directoryPath!)).toBe("Third");

    const rcopy = await store.duplicateRequest(c.folders[0].requests[0].id);
    expect(rcopy.name).toBe("R Copy");

    const re = await WorkspaceStore.open(tmp);
    expect(names(re.workspace.collections)).toEqual(["Better Name", "Better Name Copy"]);
    expect(re.findCollection(c.id)!.variables).toEqual([{ key: "a", value: "1", enabled: true }]);
    expect(re.findFolder(fcopy.id)!.folder.description).toBe("desc");

    await store.deleteFolder(fcopy.id);
    await store.deleteRequest(rcopy.id);
    await store.deleteCollection(copy.id);
    const re2 = await WorkspaceStore.open(tmp);
    expect(names(re2.workspace.collections)).toEqual(["Better Name"]);
    expect(names(re2.workspace.collections[0].folders)).toEqual(["Sub"]);
    expect(names(re2.workspace.collections[0].folders[0].requests)).toEqual(["R"]);
  });

  it("makes duplicate ids from copied files unique in memory", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c = await store.createCollection("API");
    const r = await store.createRequest(c.id, null, { name: "R" });
    await fs.copyFile(r.sourceFilePath!, path.join(c.directoryPath!, "zz-copy.yaml"));
    await fs.cp(c.directoryPath!, path.join(store.workspace.collectionsPath, "api-copy"), { recursive: true });
    const re = await WorkspaceStore.open(tmp);
    const ids: string[] = [];
    for (const col of re.workspace.collections) {
      ids.push(col.id);
      for (const req of col.requests) ids.push(req.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    const again = await WorkspaceStore.open(tmp);
    const ids2: string[] = [];
    for (const col of again.workspace.collections) {
      ids2.push(col.id);
      for (const req of col.requests) ids2.push(req.id);
    }
    expect(ids2).toEqual(ids);
  });

  it("manages environments and globals in the shared format", async () => {
    const store = await WorkspaceStore.create(tmp);
    const env = await store.createEnvironment("Local");
    const saved = await store.saveEnvironment({ ...env, variables: [{ key: "baseUrl", value: "http://localhost", enabled: true }] });
    const yaml = await read(saved.filePath!);
    expect(yaml).toContain("values:");
    expect(path.basename(saved.filePath!)).toBe("Local.environment.yaml");
    const renamed = await store.saveEnvironment({ ...saved, name: "Staging" });
    expect(path.basename(renamed.filePath!)).toBe("Staging.environment.yaml");
    const dup = await store.duplicateEnvironment(env.id);
    expect(dup.name).toBe("Staging Copy");
    await store.saveGlobals([{ key: "g", value: "1", enabled: true }]);

    const re = await WorkspaceStore.open(tmp);
    expect(names(re.workspace.environments).sort()).toEqual(["Staging", "Staging Copy"]);
    expect(re.findEnvironment(env.id)!.variables).toEqual([{ key: "baseUrl", value: "http://localhost", enabled: true }]);
    expect(re.workspace.globals).toEqual([{ key: "g", value: "1", enabled: true }]);

    await store.deleteEnvironment(dup.id);
    expect((await WorkspaceStore.open(tmp)).workspace.environments).toHaveLength(1);
  });

  it("reads imported environments and collections with only a definition file", async () => {
    const root = path.join(tmp, "ws");
    await fs.mkdir(path.join(root, "collections", "exported", ".resources"), { recursive: true });
    await fs.mkdir(path.join(root, "environments"), { recursive: true });
    await fs.writeFile(path.join(root, "environments", "qa.environment.yaml"), "values:\n  - key: a\n    value: b\n");
    await fs.writeFile(
      path.join(root, "collections", "exported", ".resources", "definition.yaml"),
      "name: Exported\nvariables:\n  x: '1'\nauth:\n  - type: bearer\n    token: t\n",
    );
    await fs.writeFile(path.join(root, "collections", "exported", "Get All.request.yaml"), "method: GET\nurl: http://x\n");
    const store = await WorkspaceStore.open(root);
    expect(store.workspace.rootPath).toBe(root);
    expect(store.workspace.environments[0].name).toBe("qa");
    const c = store.workspace.collections[0];
    expect(c).toMatchObject({ name: "Exported", variables: [{ key: "x", value: "1", enabled: true }] });
    expect(c.auth).toMatchObject({ type: "bearer", token: "t" });
    expect(c.requests[0].name).toBe("Get All");
    expect(c.folders).toHaveLength(0); // .resources is hidden
  });

  it("imports an in-memory collection with fresh ids", async () => {
    const store = await WorkspaceStore.create(tmp);
    const src = newCollection({ name: "Imported" });
    src.requests.push(newRequest({ name: "Same" }), newRequest({ name: "Same" }));
    const folder = newFolder({ name: "Folder" });
    folder.requests.push(newRequest({ name: "Inner" }));
    src.folders.push(folder);
    const c = await store.importCollection(src);
    expect(c.id).not.toBe(src.id);
    expect(new Set(c.requests.map((r) => r.sourceFilePath)).size).toBe(2);
    const re = await WorkspaceStore.open(tmp);
    expect(names(re.findCollection(c.id)!.requests)).toEqual(["Same", "Same"]);
    expect(names(re.findCollection(c.id)!.folders[0].requests)).toEqual(["Inner"]);
  });

  it("serializes concurrent writes", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c = await store.createCollection("API");
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.createRequest(c.id, null, { name: "Same" + (i % 2) })));
    const re = await WorkspaceStore.open(tmp);
    expect(re.workspace.collections[0].requests).toHaveLength(10);
    expect(re.workspace.collections[0].requests.map((r) => r.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => n * 1000));
  });

  it("moves an older Yamlet layout over as each file is saved", async () => {
    const root = path.join(tmp, "ws");
    const col = path.join(root, "collections", "my-api");
    await fs.mkdir(path.join(col, "users"), { recursive: true });
    await fs.mkdir(path.join(root, "environments"), { recursive: true });
    await fs.mkdir(path.join(root, "globals"), { recursive: true });
    await fs.writeFile(path.join(col, "collection.yaml"), "id: c1\nname: My API\norder: 0\nvariables:\n  - key: a\n    value: '1'\n");
    await fs.writeFile(path.join(col, "users", "folder.yaml"), "id: f1\nname: Users\norder: 0\n");
    await fs.writeFile(path.join(col, "users", "list-users.yaml"), "id: r1\nname: List Users\norder: 0\nmethod: GET\nurl: http://x\nbody:\n  type: json\n  raw: '{}'\n");
    await fs.writeFile(path.join(root, "environments", "dev.yaml"), "id: e1\nname: dev\nvariables:\n  - key: b\n    value: '2'\n");
    await fs.writeFile(path.join(root, "globals", "globals.yaml"), "variables:\n  - key: g\n    value: '3'\n");

    const store = await WorkspaceStore.open(root);
    const r = store.findRequest("r1")!.request;
    expect(r.body.raw).toBe("{}");
    await store.saveRequest(r);
    await store.updateCollection("c1", {});
    await store.updateFolder("f1", {});
    await store.saveEnvironment(store.findEnvironment("e1")!);
    await store.saveGlobals(store.workspace.globals);

    const moved = path.join(root, "collections", "My API");
    expect(existsSync(col)).toBe(false);
    expect(existsSync(path.join(moved, "collection.yaml"))).toBe(false);
    expect(await read(path.join(moved, ".resources", "definition.yaml"))).toContain("a: \"1\"");
    expect(existsSync(path.join(moved, "Users", "folder.yaml"))).toBe(false);
    expect(existsSync(path.join(moved, "Users", ".resources", "definition.yaml"))).toBe(true);
    const req = await read(path.join(moved, "Users", "List Users.request.yaml"));
    expect(req).toContain("$kind: http-request");
    expect(req).toContain("content: \"{}\"");
    expect(existsSync(path.join(root, "environments", "dev.environment.yaml"))).toBe(true);
    expect(existsSync(path.join(root, "environments", "dev.yaml"))).toBe(false);
    expect(existsSync(path.join(root, "globals", "globals.yaml"))).toBe(false);

    const re = await WorkspaceStore.open(root);
    expect(re.findRequest("r1")!.folders.map((f) => f.id)).toEqual(["f1"]);
    expect(re.findCollection("c1")!.variables).toEqual([{ key: "a", value: "1", enabled: true }]);
    expect(re.findEnvironment("e1")!.variables).toEqual([{ key: "b", value: "2", enabled: true }]);
    expect(re.workspace.globals).toEqual([{ key: "g", value: "3", enabled: true }]);
  });

  it("leaves items of other kinds alone", async () => {
    const store = await WorkspaceStore.create(tmp);
    const c = await store.createCollection("API");
    await fs.writeFile(path.join(c.directoryPath!, "Stream.request.yaml"), "$kind: websocket-request\nurl: ws://x\n");
    const re = await WorkspaceStore.open(tmp);
    expect(re.findCollection(c.id)!.requests).toHaveLength(0);
  });

  it("keeps local values out of the YAML and in the data folder", async () => {
    const data = path.join(tmp, "data");
    const open = async () => WorkspaceStore.open(tmp, { localValues: (await LocalValuesFile.open(data)).forWorkspace(path.join(tmp, "yamlet")) });
    await WorkspaceStore.create(tmp);
    const store = await open();
    const env = await store.createEnvironment("Mine");
    await store.saveEnvironment({
      ...env,
      variables: [
        { key: "baseUrl", value: "http://localhost", enabled: true },
        { key: "token", value: "s3cret", enabled: true, local: true },
      ],
    });
    const c = await store.createCollection("API");
    await store.updateCollection(c.id, { variables: [{ key: "apiKey", value: "k-123", enabled: true, local: true }] });
    await store.saveGlobals([{ key: "me", value: "pd", enabled: true, local: true }]);

    expect(await read(store.findEnvironment(env.id)!.filePath!)).not.toContain("s3cret");
    expect(await read(store.findCollection(c.id)!.filePath!)).not.toContain("k-123");
    const stored = JSON.parse(await read(path.join(data, "local-values.json")));
    expect(stored.workspaces[path.join(tmp, "yamlet")]).toEqual({
      [`environment:${env.id}`]: { token: "s3cret" },
      [`collection:${c.id}`]: { apiKey: "k-123" },
      globals: { me: "pd" },
    });

    // Reopened (a restart or an upgrade), the values come back.
    const re = await open();
    expect(re.findEnvironment(env.id)!.variables).toEqual([
      { key: "baseUrl", value: "http://localhost", enabled: true },
      { key: "token", value: "s3cret", enabled: true, local: true },
    ]);
    expect(re.findCollection(c.id)!.variables).toEqual([{ key: "apiKey", value: "k-123", enabled: true, local: true }]);
    expect(re.workspace.globals).toEqual([{ key: "me", value: "pd", enabled: true, local: true }]);
    // Without the data folder (e.g. the CLI in CI) the keys are there with blank values.
    expect((await WorkspaceStore.open(tmp)).findEnvironment(env.id)!.variables[1]).toEqual({ key: "token", value: "", enabled: true, local: true });

    // Another tool that drops the flag but keeps the blank key still gets the local value back.
    const file = re.findEnvironment(env.id)!.filePath!;
    await fs.writeFile(file, (await read(file)).replace("    local: true\n", ""));
    expect((await open()).findEnvironment(env.id)!.variables[1]).toEqual({ key: "token", value: "s3cret", enabled: true, local: true });

    // Switching a variable back to the file moves its value into the YAML; deleting forgets the rest.
    await re.saveEnvironment({ ...re.findEnvironment(env.id)!, variables: [{ key: "token", value: "s3cret", enabled: true }] });
    expect(await read(re.findEnvironment(env.id)!.filePath!)).toContain("s3cret");
    await re.deleteCollection(c.id);
    const after = JSON.parse(await read(path.join(data, "local-values.json")));
    expect(after.workspaces[path.join(tmp, "yamlet")]).toEqual({ globals: { me: "pd" } });
  });

  it("opens the sample workspace", async () => {
    const store = await WorkspaceStore.open(path.resolve(__dirname, "../../samples/demo"));
    const ws = store.workspace;
    expect(ws.environments.map((e) => e.name)).toEqual(["dev"]);
    expect(ws.globals).toContainEqual({ key: "appName", value: "Yamlet", enabled: true });
    const c = ws.collections[0];
    expect(c.name).toBe("JSONPlaceholder");
    expect(names(c.folders)).toEqual(["Users", "Posts"]);
    expect(names(c.folders[1].requests)).toEqual(["List Posts", "Get Post", "Create Post"]);
    const create = c.folders[1].requests[2];
    expect(create.body.type).toBe("json");
    expect(create.postResponseScript).toContain("pm.test");
  });
});

describe("fileSafeName", () => {
  it("keeps the display name and replaces what file systems reject", () => {
    expect(fileSafeName("My API")).toBe("My API");
    expect(fileSafeName("  Get / Users: (v2)?  ")).toBe("Get - Users- (v2)-");
    expect(fileSafeName("..hidden.")).toBe("hidden");
    expect(fileSafeName("CON")).toBe("CON_");
    expect(fileSafeName("   ", "New Request")).toBe("New Request");
  });
});
