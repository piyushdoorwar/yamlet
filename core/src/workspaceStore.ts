// In-memory workspace backed by the YAML tree on disk. Every mutation is applied to
// the in-memory model and written through to disk; writes are serialized.
//
// Layout: <root>/collections/<collection>/collection.yaml, <request>.yaml,
// <folder>/folder.yaml, <folder>/<request>.yaml; <root>/environments/<name>.yaml;
// <root>/globals/globals.yaml.
import { existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import {
  newCollection,
  newEnvironment,
  newFolder,
  newId,
  newRequest,
  type Variable,
  type YamletCollection,
  type YamletEnvironment,
  type YamletFolder,
  type YamletRequest,
  type YamletWorkspace,
} from "./models.js";
import { slugify, uniqueDirectoryPath, uniqueFilePath } from "./pathNaming.js";
import {
  applyCollectionDefinition,
  applyCollectionMetadata,
  applyFolderMetadata,
  collectionToYaml,
  environmentFromDto,
  environmentToYaml,
  folderToYaml,
  globalsFromYaml,
  globalsToYaml,
  isObj,
  loadYaml,
  requestFromDto,
  requestToYaml,
} from "./yamlDtos.js";

export const ROOT_DIR_NAME = "yamlet";
export const COLLECTIONS_DIR = "collections";
export const ENVIRONMENTS_DIR = "environments";
export const GLOBALS_DIR = "globals";
export const GLOBALS_FILE = "globals.yaml";
export const COLLECTION_FILE = "collection.yaml";
export const FOLDER_FILE = "folder.yaml";
export const DEFINITION_FILE = path.join(".resources", "definition.yaml");
export const REQUEST_EXTENSION = ".yaml";

export interface RequestLocation {
  request: YamletRequest;
  collection: YamletCollection;
  /** Ancestor folders, outermost first. */
  folders: YamletFolder[];
}

export interface FolderLocation {
  folder: YamletFolder;
  collection: YamletCollection;
  /** Ancestor folders (excluding `folder`), outermost first. */
  folders: YamletFolder[];
}

export type CollectionPatch = Partial<
  Pick<YamletCollection, "name" | "description" | "variables" | "auth" | "preRequestScript" | "postResponseScript">
>;

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isYamlFile = (name: string) => /\.ya?ml$/i.test(name);

/** Stable id for entities whose files carry none, so ids survive reloads. FNV-1a 64-bit. */
function stableId(prefix: string, key: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(key)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `${prefix}-${h.toString(16).padStart(16, "0")}`;
}

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Stable sort by `order`; the input is already in filename order, which breaks ties. */
const byOrder = <T extends { order: number }>(list: T[]) => list.sort((a, b) => a.order - b.order);
const nextOrder = (list: { order: number }[]) => list.reduce((m, x) => Math.max(m, (x.order ?? 0) + 1), 0);

async function readIfExists(p: string | undefined): Promise<string | undefined> {
  if (!p) return undefined;
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

async function writeFileAtomic(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, p);
}

async function listDir(dir: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory() })).sort((a, b) => ordinal(a.name, b.name));
  } catch {
    return [];
  }
}

function repath(p: string | undefined, from: string, to: string): string | undefined {
  if (!p) return p;
  if (p === from) return to;
  return p.startsWith(from + path.sep) ? to + p.slice(from.length) : p;
}

function repathTree(node: YamletCollection | YamletFolder, from: string, to: string): void {
  node.directoryPath = repath(node.directoryPath, from, to);
  if ("filePath" in node) node.filePath = repath(node.filePath, from, to);
  for (const r of node.requests) r.sourceFilePath = repath(r.sourceFilePath, from, to);
  for (const f of node.folders) repathTree(f, from, to);
}

function freshIds(node: YamletCollection | YamletFolder): void {
  node.id = newId();
  for (const r of node.requests) {
    r.id = newId();
    for (const e of r.examples ?? []) e.id = newId();
  }
  for (const f of node.folders) freshIds(f);
}

function copyName(name: string): string {
  return `${name} Copy`;
}

export class WorkspaceStore {
  workspace: YamletWorkspace;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(workspace: YamletWorkspace) {
    this.workspace = workspace;
  }

  // ---- Opening -------------------------------------------------------------

  /** The picked folder if it already holds collections/ + environments/ (or is named `yamlet`), else `<dir>/yamlet`. */
  static resolveRoot(dir: string): string {
    const abs = path.resolve(dir);
    const looksLikeRoot = isDir(path.join(abs, COLLECTIONS_DIR)) && isDir(path.join(abs, ENVIRONMENTS_DIR));
    if (looksLikeRoot || path.basename(abs).toLowerCase() === ROOT_DIR_NAME) return abs;
    return path.join(abs, ROOT_DIR_NAME);
  }

  static async isWorkspace(dir: string): Promise<boolean> {
    return isDir(path.join(WorkspaceStore.resolveRoot(dir), COLLECTIONS_DIR));
  }

  /** Opens an existing workspace. Does not create anything on disk. */
  static async open(dir: string): Promise<WorkspaceStore> {
    const root = WorkspaceStore.resolveRoot(dir);
    if (!isDir(root)) throw new Error(`No Yamlet workspace found at ${dir}`);
    return new WorkspaceStore(await loadWorkspace(root));
  }

  /** Creates the workspace skeleton (seeding globals) where missing, then opens it. */
  static async create(dir: string): Promise<WorkspaceStore> {
    const root = WorkspaceStore.resolveRoot(dir);
    await fs.mkdir(path.join(root, COLLECTIONS_DIR), { recursive: true });
    await fs.mkdir(path.join(root, ENVIRONMENTS_DIR), { recursive: true });
    await fs.mkdir(path.join(root, GLOBALS_DIR), { recursive: true });
    const globals = path.join(root, GLOBALS_DIR, GLOBALS_FILE);
    if (!existsSync(globals)) {
      await writeFileAtomic(globals, globalsToYaml([{ key: "appName", value: "Yamlet", enabled: true }]));
    }
    return WorkspaceStore.open(root);
  }

  get rootPath(): string {
    return this.workspace.rootPath;
  }

  async reload(): Promise<YamletWorkspace> {
    return this.enqueue(async () => {
      this.workspace = await loadWorkspace(this.workspace.rootPath);
      return this.workspace;
    });
  }

  // ---- Lookups -------------------------------------------------------------

  findCollection(id: string): YamletCollection | undefined {
    return this.workspace.collections.find((c) => c.id === id);
  }

  findEnvironment(id: string): YamletEnvironment | undefined {
    return this.workspace.environments.find((e) => e.id === id);
  }

  findRequest(id: string): RequestLocation | undefined {
    const hit = this.locateRequest(id);
    return hit && { request: hit.request, collection: hit.collection, folders: hit.folders };
  }

  findFolder(id: string): FolderLocation | undefined {
    const hit = this.locateFolder(id);
    return hit && { folder: hit.folder, collection: hit.collection, folders: hit.folders };
  }

  private locateRequest(id: string) {
    for (const collection of this.workspace.collections) {
      const walk = (node: YamletCollection | YamletFolder, chain: YamletFolder[]): RequestLocation & { list: YamletRequest[] } | undefined => {
        const request = node.requests.find((r) => r.id === id);
        if (request) return { request, collection, folders: chain, list: node.requests };
        for (const f of node.folders) {
          const hit = walk(f, [...chain, f]);
          if (hit) return hit;
        }
        return undefined;
      };
      const hit = walk(collection, []);
      if (hit) return hit;
    }
    return undefined;
  }

  private locateFolder(id: string) {
    for (const collection of this.workspace.collections) {
      const walk = (node: YamletCollection | YamletFolder, chain: YamletFolder[]): FolderLocation & { list: YamletFolder[] } | undefined => {
        for (const f of node.folders) {
          if (f.id === id) return { folder: f, collection, folders: chain, list: node.folders };
          const hit = walk(f, [...chain, f]);
          if (hit) return hit;
        }
        return undefined;
      };
      const hit = walk(collection, []);
      if (hit) return hit;
    }
    return undefined;
  }

  private requireCollection(id: string): YamletCollection {
    const c = this.findCollection(id);
    if (!c) throw new Error(`Collection not found: ${id}`);
    return c;
  }

  /** The container (collection root or folder) that new children go into. */
  private container(collectionId: string, folderId: string | null) {
    const collection = this.requireCollection(collectionId);
    let folder: YamletFolder | null = null;
    if (folderId) {
      const hit = this.locateFolder(folderId);
      if (!hit || hit.collection !== collection) throw new Error(`Folder not found in collection: ${folderId}`);
      folder = hit.folder;
    }
    const node = folder ?? collection;
    const dir = node.directoryPath;
    if (!dir) throw new Error("Container has no directory");
    return { collection, folder, node, dir };
  }

  // ---- Collections ---------------------------------------------------------

  async createCollection(name: string): Promise<YamletCollection> {
    return this.enqueue(async () => {
      const ws = this.workspace;
      await fs.mkdir(ws.collectionsPath, { recursive: true });
      const dir = uniqueDirectoryPath(ws.collectionsPath, slugify(name, "collection"));
      await fs.mkdir(dir, { recursive: true });
      const c = newCollection({
        name: name.trim() || "New Collection",
        directoryPath: dir,
        filePath: path.join(dir, COLLECTION_FILE),
        order: nextOrder(ws.collections),
      });
      await this.writeCollection(c);
      ws.collections.push(c);
      return c;
    });
  }

  async updateCollection(id: string, patch: CollectionPatch): Promise<YamletCollection> {
    return this.enqueue(async () => {
      const c = this.requireCollection(id);
      if (patch.name !== undefined && patch.name.trim() && patch.name !== c.name) {
        c.name = patch.name;
        await this.renameNodeDir(c, this.workspace.collectionsPath, slugify(c.name, "collection"));
      }
      if (patch.description !== undefined) c.description = patch.description;
      if (patch.variables !== undefined) c.variables = patch.variables;
      if (patch.auth !== undefined) c.auth = patch.auth;
      if (patch.preRequestScript !== undefined) c.preRequestScript = patch.preRequestScript;
      if (patch.postResponseScript !== undefined) c.postResponseScript = patch.postResponseScript;
      await this.writeCollection(c);
      return c;
    });
  }

  async deleteCollection(id: string): Promise<YamletCollection> {
    return this.enqueue(async () => {
      const c = this.requireCollection(id);
      if (c.directoryPath) await fs.rm(c.directoryPath, { recursive: true, force: true });
      this.workspace.collections = this.workspace.collections.filter((x) => x !== c);
      return c;
    });
  }

  async duplicateCollection(id: string): Promise<YamletCollection> {
    return this.enqueue(async () => {
      const src = this.requireCollection(id);
      if (!src.directoryPath) throw new Error("Collection has no directory");
      const name = copyName(src.name);
      const dir = uniqueDirectoryPath(this.workspace.collectionsPath, slugify(name, "collection"));
      // Copying the directory keeps non-modeled files and unknown YAML keys.
      await fs.cp(src.directoryPath, dir, { recursive: true });
      const c = structuredClone(src);
      repathTree(c, src.directoryPath, dir);
      freshIds(c);
      c.name = name;
      c.filePath = path.join(dir, COLLECTION_FILE);
      c.order = nextOrder(this.workspace.collections);
      await this.writeTree(c);
      this.workspace.collections.push(c);
      return c;
    });
  }

  /** Writes an in-memory collection (e.g. from an importer) as a new collection with fresh ids. */
  async importCollection(imported: YamletCollection): Promise<YamletCollection> {
    return this.enqueue(async () => {
      const ws = this.workspace;
      const c = structuredClone(imported);
      freshIds(c);
      c.name = c.name?.trim() || "Imported Collection";
      const dir = uniqueDirectoryPath(ws.collectionsPath, slugify(c.name, "collection"));
      await fs.mkdir(dir, { recursive: true });
      c.directoryPath = dir;
      c.filePath = path.join(dir, COLLECTION_FILE);
      c.order = nextOrder(ws.collections);
      // uniqueFilePath checks the disk, so each request is written as soon as it is placed.
      const placeAndWrite = async (node: YamletCollection | YamletFolder, nodeDir: string) => {
        for (const [i, r] of node.requests.entries()) {
          r.order = i;
          r.sourceFilePath = uniqueFilePath(nodeDir, slugify(r.name, "request") + REQUEST_EXTENSION);
          await writeFileAtomic(r.sourceFilePath, requestToYaml(r));
        }
        for (const [i, f] of node.folders.entries()) {
          f.order = i;
          f.directoryPath = uniqueDirectoryPath(nodeDir, slugify(f.name, "folder"));
          await fs.mkdir(f.directoryPath, { recursive: true });
          await writeFileAtomic(path.join(f.directoryPath, FOLDER_FILE), folderToYaml(f));
          await placeAndWrite(f, f.directoryPath);
        }
      };
      await placeAndWrite(c, dir);
      await writeFileAtomic(c.filePath, collectionToYaml(c));
      ws.collections.push(c);
      return c;
    });
  }

  // ---- Folders -------------------------------------------------------------

  async createFolder(collectionId: string, parentFolderId: string | null, name: string): Promise<YamletFolder> {
    return this.enqueue(async () => {
      const { node, dir } = this.container(collectionId, parentFolderId);
      const folderDir = uniqueDirectoryPath(dir, slugify(name, "folder"));
      await fs.mkdir(folderDir, { recursive: true });
      const f = newFolder({ name: name.trim() || "New Folder", directoryPath: folderDir, order: nextOrder(node.folders) });
      await this.writeFolder(f);
      node.folders.push(f);
      return f;
    });
  }

  async updateFolder(id: string, patch: { name?: string; description?: string }): Promise<YamletFolder> {
    return this.enqueue(async () => {
      const hit = this.locateFolder(id);
      if (!hit) throw new Error(`Folder not found: ${id}`);
      const f = hit.folder;
      if (patch.name !== undefined && patch.name.trim() && patch.name !== f.name) {
        f.name = patch.name;
        const parentDir = path.dirname(f.directoryPath!);
        await this.renameNodeDir(f, parentDir, slugify(f.name, "folder"));
      }
      if (patch.description !== undefined) f.description = patch.description;
      await this.writeFolder(f);
      return f;
    });
  }

  async deleteFolder(id: string): Promise<YamletFolder> {
    return this.enqueue(async () => {
      const hit = this.locateFolder(id);
      if (!hit) throw new Error(`Folder not found: ${id}`);
      if (hit.folder.directoryPath) await fs.rm(hit.folder.directoryPath, { recursive: true, force: true });
      hit.list.splice(hit.list.indexOf(hit.folder), 1);
      return hit.folder;
    });
  }

  async duplicateFolder(id: string): Promise<YamletFolder> {
    return this.enqueue(async () => {
      const hit = this.locateFolder(id);
      if (!hit?.folder.directoryPath) throw new Error(`Folder not found: ${id}`);
      const src = hit.folder;
      const srcDir = src.directoryPath!;
      const name = copyName(src.name);
      const dir = uniqueDirectoryPath(path.dirname(srcDir), slugify(name, "folder"));
      await fs.cp(srcDir, dir, { recursive: true });
      const f = structuredClone(src);
      repathTree(f, srcDir, dir);
      freshIds(f);
      f.name = name;
      await this.writeTree(f);
      hit.list.splice(hit.list.indexOf(src) + 1, 0, f);
      await this.saveContainerOrder(hit.collection, hit.folders.at(-1) ?? null);
      return f;
    });
  }

  // ---- Requests ------------------------------------------------------------

  async createRequest(collectionId: string, parentFolderId: string | null, init?: Partial<YamletRequest>): Promise<YamletRequest> {
    return this.enqueue(async () => {
      const { node, dir } = this.container(collectionId, parentFolderId);
      const name = init?.name?.trim() ? init.name : "New Request";
      const file = uniqueFilePath(dir, slugify(name, "request") + REQUEST_EXTENSION);
      const id = init?.id && !this.idInUse(init.id) ? init.id : newId();
      const r = newRequest({ ...init, id, name, sourceFilePath: file, order: nextOrder(node.requests) });
      r.method = (r.method || "GET").toUpperCase();
      await writeFileAtomic(file, requestToYaml(r));
      node.requests.push(r);
      return r;
    });
  }

  /** Replaces a request by id and rewrites its file, renaming the file when the name changed. */
  async saveRequest(request: YamletRequest): Promise<YamletRequest> {
    return this.enqueue(async () => {
      const hit = this.locateRequest(request.id);
      if (!hit) throw new Error(`Request not found: ${request.id}`);
      const existing = hit.request;
      const updated: YamletRequest = {
        ...structuredClone(request),
        method: (request.method || "GET").toUpperCase(),
        order: existing.order,
        sourceFilePath: existing.sourceFilePath,
      };
      let file = existing.sourceFilePath;
      if (!file) throw new Error("Request has no file path");
      if (updated.name !== existing.name && updated.name.trim()) {
        const target = uniqueFilePath(path.dirname(file), slugify(updated.name, "request") + REQUEST_EXTENSION, file);
        if (target !== file) {
          if (existsSync(file)) await fs.rename(file, target);
          file = target;
        }
      }
      updated.sourceFilePath = file;
      await writeFileAtomic(file, requestToYaml(updated, await readIfExists(file)));
      hit.list[hit.list.indexOf(existing)] = updated;
      return updated;
    });
  }

  async deleteRequest(id: string): Promise<YamletRequest> {
    return this.enqueue(async () => {
      const hit = this.locateRequest(id);
      if (!hit) throw new Error(`Request not found: ${id}`);
      if (hit.request.sourceFilePath) await fs.rm(hit.request.sourceFilePath, { force: true });
      hit.list.splice(hit.list.indexOf(hit.request), 1);
      return hit.request;
    });
  }

  async duplicateRequest(id: string): Promise<YamletRequest> {
    return this.enqueue(async () => {
      const hit = this.locateRequest(id);
      if (!hit?.request.sourceFilePath) throw new Error(`Request not found: ${id}`);
      const src = hit.request;
      const r = structuredClone(src);
      r.id = newId();
      for (const e of r.examples ?? []) e.id = newId();
      r.name = copyName(src.name);
      r.sourceFilePath = uniqueFilePath(path.dirname(src.sourceFilePath!), slugify(r.name, "request") + REQUEST_EXTENSION);
      await writeFileAtomic(r.sourceFilePath, requestToYaml(r, await readIfExists(src.sourceFilePath)));
      hit.list.splice(hit.list.indexOf(src) + 1, 0, r);
      await this.saveContainerOrder(hit.collection, hit.folders.at(-1) ?? null);
      return r;
    });
  }

  // ---- Moving --------------------------------------------------------------

  /**
   * Moves a request or folder into a target container at `index` (position in the target's
   * list after removal from its source). Files/directories move on disk when the parent
   * changes; both containers are renumbered.
   */
  async move(
    kind: "request" | "folder",
    id: string,
    targetCollectionId: string,
    targetFolderId: string | null,
    index: number,
  ): Promise<YamletRequest | YamletFolder> {
    return this.enqueue(async () => {
      const target = this.container(targetCollectionId, targetFolderId);
      const clampInsert = <T>(list: T[], item: T) => list.splice(Math.max(0, Math.min(index, list.length)), 0, item);

      if (kind === "request") {
        const hit = this.locateRequest(id);
        if (!hit) throw new Error(`Request not found: ${id}`);
        const r = hit.request;
        hit.list.splice(hit.list.indexOf(r), 1);
        if (r.sourceFilePath && path.dirname(r.sourceFilePath) !== target.dir) {
          const dest = uniqueFilePath(target.dir, path.basename(r.sourceFilePath));
          await fs.rename(r.sourceFilePath, dest);
          r.sourceFilePath = dest;
        }
        clampInsert(target.node.requests, r);
        await this.saveContainerOrder(target.collection, target.folder);
        const source = hit.folders.at(-1) ?? null;
        if (hit.collection !== target.collection || source !== target.folder) await this.saveContainerOrder(hit.collection, source);
        return r;
      }

      const hit = this.locateFolder(id);
      if (!hit) throw new Error(`Folder not found: ${id}`);
      const f = hit.folder;
      if (targetFolderId === f.id || (targetFolderId && this.locateFolder(targetFolderId)?.folders.some((a) => a.id === f.id))) {
        throw new Error("Cannot move a folder into itself");
      }
      hit.list.splice(hit.list.indexOf(f), 1);
      const from = f.directoryPath!;
      if (path.dirname(from) !== target.dir) {
        const dest = uniqueDirectoryPath(target.dir, path.basename(from));
        await fs.rename(from, dest);
        repathTree(f, from, dest);
      }
      clampInsert(target.node.folders, f);
      await this.saveContainerOrder(target.collection, target.folder);
      const source = hit.folders.at(-1) ?? null;
      if (hit.collection !== target.collection || source !== target.folder) await this.saveContainerOrder(hit.collection, source);
      return f;
    });
  }

  /** Renumbers a container's direct children to their list order; rewrites only changed files. */
  private async saveContainerOrder(collection: YamletCollection, folder: YamletFolder | null): Promise<void> {
    const node = folder ?? collection;
    for (const [i, r] of node.requests.entries()) {
      if (r.order === i && existsSync(r.sourceFilePath ?? "")) continue;
      r.order = i;
      if (r.sourceFilePath) await writeFileAtomic(r.sourceFilePath, requestToYaml(r, await readIfExists(r.sourceFilePath)));
    }
    for (const [i, f] of node.folders.entries()) {
      if (f.order === i && existsSync(path.join(f.directoryPath ?? "", FOLDER_FILE))) continue;
      f.order = i;
      await this.writeFolder(f);
    }
  }

  // ---- Environments and globals --------------------------------------------

  async createEnvironment(name: string): Promise<YamletEnvironment> {
    return this.enqueue(async () => {
      const ws = this.workspace;
      const file = uniqueFilePath(ws.environmentsPath, slugify(name, "environment") + ".yaml");
      const env = newEnvironment({ name: name.trim() || "New Environment", filePath: file });
      await writeFileAtomic(file, environmentToYaml(env));
      ws.environments.push(env);
      return env;
    });
  }

  async importEnvironment(imported: YamletEnvironment): Promise<YamletEnvironment> {
    return this.enqueue(async () => {
      const ws = this.workspace;
      const env = { ...structuredClone(imported), id: newId(), name: imported.name?.trim() || "Imported Environment" };
      env.filePath = uniqueFilePath(ws.environmentsPath, slugify(env.name, "environment") + ".yaml");
      await writeFileAtomic(env.filePath, environmentToYaml(env));
      ws.environments.push(env);
      return env;
    });
  }

  async saveEnvironment(env: YamletEnvironment): Promise<YamletEnvironment> {
    return this.enqueue(async () => {
      const list = this.workspace.environments;
      const idx = list.findIndex((e) => e.id === env.id);
      if (idx < 0) throw new Error(`Environment not found: ${env.id}`);
      const existing = list[idx];
      let file = existing.filePath ?? uniqueFilePath(this.workspace.environmentsPath, slugify(env.name, "environment") + ".yaml");
      if (env.name !== existing.name && env.name.trim() && existing.filePath) {
        const target = uniqueFilePath(path.dirname(file), slugify(env.name, "environment") + ".yaml", file);
        if (target !== file) {
          if (existsSync(file)) await fs.rename(file, target);
          file = target;
        }
      }
      const updated: YamletEnvironment = { ...structuredClone(env), filePath: file };
      await writeFileAtomic(file, environmentToYaml(updated, await readIfExists(file)));
      list[idx] = updated;
      return updated;
    });
  }

  async deleteEnvironment(id: string): Promise<YamletEnvironment> {
    return this.enqueue(async () => {
      const list = this.workspace.environments;
      const env = list.find((e) => e.id === id);
      if (!env) throw new Error(`Environment not found: ${id}`);
      if (env.filePath) await fs.rm(env.filePath, { force: true });
      list.splice(list.indexOf(env), 1);
      return env;
    });
  }

  async duplicateEnvironment(id: string): Promise<YamletEnvironment> {
    return this.enqueue(async () => {
      const list = this.workspace.environments;
      const src = list.find((e) => e.id === id);
      if (!src) throw new Error(`Environment not found: ${id}`);
      const env: YamletEnvironment = { ...structuredClone(src), id: newId(), name: copyName(src.name) };
      env.filePath = uniqueFilePath(this.workspace.environmentsPath, slugify(env.name, "environment") + ".yaml");
      await writeFileAtomic(env.filePath, environmentToYaml(env, await readIfExists(src.filePath)));
      list.splice(list.indexOf(src) + 1, 0, env);
      return env;
    });
  }

  async saveGlobals(vars: Variable[]): Promise<Variable[]> {
    return this.enqueue(async () => {
      const file = path.join(this.workspace.globalsPath, GLOBALS_FILE);
      await writeFileAtomic(file, globalsToYaml(vars, await readIfExists(file)));
      this.workspace.globals = structuredClone(vars);
      return this.workspace.globals;
    });
  }

  // ---- Internals -----------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private idInUse(id: string): boolean {
    return !!(this.findCollection(id) || this.locateRequest(id) || this.locateFolder(id) || this.findEnvironment(id));
  }

  private async renameNodeDir(node: YamletCollection | YamletFolder, parentDir: string, slug: string): Promise<void> {
    const from = node.directoryPath;
    if (!from || path.basename(from) === slug) return;
    const to = uniqueDirectoryPath(parentDir, slug, from);
    if (to === from) return;
    await fs.rename(from, to);
    repathTree(node, from, to);
  }

  private async writeCollection(c: YamletCollection): Promise<void> {
    if (!c.directoryPath) throw new Error("Collection has no directory");
    c.filePath = path.join(c.directoryPath, COLLECTION_FILE);
    await writeFileAtomic(c.filePath, collectionToYaml(c, await readIfExists(c.filePath)));
  }

  private async writeFolder(f: YamletFolder): Promise<void> {
    if (!f.directoryPath) return;
    const file = path.join(f.directoryPath, FOLDER_FILE);
    await writeFileAtomic(file, folderToYaml(f, await readIfExists(file)));
  }

  /** Rewrites every metadata and request file under a node (used after copying a directory). */
  private async writeTree(node: YamletCollection | YamletFolder): Promise<void> {
    if ("variables" in node) await this.writeCollection(node);
    else await this.writeFolder(node);
    for (const r of node.requests) {
      if (r.sourceFilePath) await writeFileAtomic(r.sourceFilePath, requestToYaml(r, await readIfExists(r.sourceFilePath)));
    }
    for (const f of node.folders) await this.writeTree(f);
  }
}

// ---------------------------------------------------------------------------
// Loading

async function loadWorkspace(root: string): Promise<YamletWorkspace> {
  const base = path.basename(root);
  const ws: YamletWorkspace = {
    name: base.toLowerCase() === ROOT_DIR_NAME ? path.basename(path.dirname(root)) || base : base,
    rootPath: root,
    collectionsPath: path.join(root, COLLECTIONS_DIR),
    environmentsPath: path.join(root, ENVIRONMENTS_DIR),
    globalsPath: path.join(root, GLOBALS_DIR),
    collections: [],
    environments: [],
    globals: [],
  };
  const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");

  for (const entry of await listDir(ws.collectionsPath)) {
    if (!entry.dir || entry.name.startsWith(".")) continue;
    try {
      ws.collections.push(await loadCollection(path.join(ws.collectionsPath, entry.name), rel));
    } catch {
      // Skip unreadable collections rather than failing the whole open.
    }
  }
  byOrder(ws.collections);

  for (const entry of await listDir(ws.environmentsPath)) {
    if (entry.dir || !isYamlFile(entry.name)) continue;
    const file = path.join(ws.environmentsPath, entry.name);
    try {
      const raw = loadYaml(await fs.readFile(file, "utf8"));
      const env = environmentFromDto(raw, file);
      if (!isObj(raw) || !String(raw.id ?? "").trim()) env.id = stableId("e", rel(file));
      ws.environments.push(env);
    } catch {
      // Skip malformed environment files.
    }
  }

  const globalsText = await readIfExists(path.join(ws.globalsPath, GLOBALS_FILE));
  if (globalsText) {
    try {
      ws.globals = globalsFromYaml(globalsText);
    } catch {
      ws.globals = [];
    }
  }

  ensureUniqueIds(ws, rel);
  return ws;
}

async function loadCollection(dir: string, rel: (p: string) => string): Promise<YamletCollection> {
  const c = newCollection({
    id: stableId("c", rel(dir)),
    name: path.basename(dir),
    directoryPath: dir,
    filePath: path.join(dir, COLLECTION_FILE),
  });
  // An exported definition is applied first so a native collection.yaml can override it.
  const definition = await readIfExists(path.join(dir, DEFINITION_FILE));
  if (definition) applyCollectionDefinition(c, loadYaml(definition));
  const metadata = await readIfExists(c.filePath);
  if (metadata) applyCollectionMetadata(c, loadYaml(metadata));
  c.requests = await loadRequests(dir, rel);
  c.folders = await loadFolders(dir, rel);
  return c;
}

async function loadFolders(parentDir: string, rel: (p: string) => string): Promise<YamletFolder[]> {
  const folders: YamletFolder[] = [];
  for (const entry of await listDir(parentDir)) {
    if (!entry.dir || entry.name.startsWith(".")) continue; // .resources, .git, ...
    const dir = path.join(parentDir, entry.name);
    const f = newFolder({ id: stableId("f", rel(dir)), name: entry.name, directoryPath: dir });
    const meta = await readIfExists(path.join(dir, FOLDER_FILE));
    if (meta) {
      try {
        applyFolderMetadata(f, loadYaml(meta));
      } catch {
        // A malformed folder.yaml falls back to the directory name and order 0.
      }
    }
    f.requests = await loadRequests(dir, rel);
    f.folders = await loadFolders(dir, rel);
    folders.push(f);
  }
  return byOrder(folders);
}

async function loadRequests(dir: string, rel: (p: string) => string): Promise<YamletRequest[]> {
  const requests: YamletRequest[] = [];
  for (const entry of await listDir(dir)) {
    if (entry.dir || !isYamlFile(entry.name)) continue;
    const lower = entry.name.toLowerCase();
    if (lower === COLLECTION_FILE || lower === FOLDER_FILE) continue;
    const file = path.join(dir, entry.name);
    try {
      const raw = loadYaml(await fs.readFile(file, "utf8"));
      if (!isObj(raw)) continue;
      const r = requestFromDto(raw, file);
      if (!String(raw.id ?? "").trim()) r.id = stableId("r", rel(file));
      requests.push(r);
    } catch {
      // Skip malformed request files.
    }
  }
  return byOrder(requests);
}

/** Ids must be unique in memory (copied files share ids); duplicates get a stable path-derived id. */
function ensureUniqueIds(ws: YamletWorkspace, rel: (p: string) => string): void {
  const seen = new Set<string>();
  const claim = (current: string, prefix: string, key: string): string => {
    let id = current;
    for (let n = 0; !id || seen.has(id); n++) id = stableId(prefix, `${key}#${n}`);
    seen.add(id);
    return id;
  };
  const walk = (node: YamletCollection | YamletFolder) => {
    for (const r of node.requests) r.id = claim(r.id, "r", rel(r.sourceFilePath ?? r.name));
    for (const f of node.folders) {
      f.id = claim(f.id, "f", rel(f.directoryPath ?? f.name));
      walk(f);
    }
  };
  for (const c of ws.collections) {
    c.id = claim(c.id, "c", rel(c.directoryPath ?? c.name));
    walk(c);
  }
  for (const e of ws.environments) e.id = claim(e.id, "e", rel(e.filePath ?? e.name));
}
