// In-memory workspace backed by the YAML tree on disk. Every mutation is applied to
// the in-memory model and written through to disk; writes are serialized.
//
// Layout (the local collection format shared with v2.1-compatible clients):
//   <root>/collections/<Collection>/.resources/definition.yaml
//   <root>/collections/<Collection>/<Request>.request.yaml
//   <root>/collections/<Collection>/<Folder>/.resources/definition.yaml + <Request>.request.yaml
//   <root>/environments/<name>.environment.yaml
//   <root>/globals/workspace.globals.yaml
// Older Yamlet files (collection.yaml, folder.yaml, <slug>.yaml, globals.yaml) are read and
// moved to this layout the next time each one is saved.
//
// Variables marked `local` keep their values in a LocalValues store instead of the YAML.
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
import { collectionScope, environmentScope, GLOBALS_SCOPE, type LocalScope, type LocalValues } from "./localValues.js";
import { fileSafeName, uniqueDirectoryPath, uniqueFilePath } from "./pathNaming.js";
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
  REQUEST_KIND,
  requestFromDto,
  requestToYaml,
} from "./yamlDtos.js";

export const ROOT_DIR_NAME = "yamlet";
export const COLLECTIONS_DIR = "collections";
export const ENVIRONMENTS_DIR = "environments";
export const GLOBALS_DIR = "globals";
export const GLOBALS_FILE = "workspace.globals.yaml";
export const DEFINITION_FILE = path.join(".resources", "definition.yaml");
export const REQUEST_SUFFIX = ".request.yaml";
export const ENVIRONMENT_SUFFIX = ".environment.yaml";
/** Read for older workspaces, removed when the replacement is written. */
export const LEGACY_COLLECTION_FILE = "collection.yaml";
export const LEGACY_FOLDER_FILE = "folder.yaml";
export const LEGACY_GLOBALS_FILE = "globals.yaml";
/** Sibling order is spaced so another tool can slot items in between without renumbering. */
export const ORDER_STEP = 1000;

export interface StoreOptions {
  /** Where `local` variable values live; without it they stay in memory only. */
  localValues?: LocalValues;
}

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
const nextOrder = (list: { order: number }[]) => list.reduce((m, x) => Math.max(m, (x.order ?? 0) + ORDER_STEP), ORDER_STEP);

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
  private readonly local?: LocalValues;

  private constructor(workspace: YamletWorkspace, options: StoreOptions) {
    this.workspace = workspace;
    this.local = options.localValues;
    if (this.local) applyLocalValues(workspace, this.local);
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
  static async open(dir: string, options: StoreOptions = {}): Promise<WorkspaceStore> {
    const root = WorkspaceStore.resolveRoot(dir);
    if (!isDir(root)) throw new Error(`No Yamlet workspace found at ${dir}`);
    return new WorkspaceStore(await loadWorkspace(root), options);
  }

  /** Creates the workspace skeleton (seeding globals) where missing, then opens it. */
  static async create(dir: string, options: StoreOptions = {}): Promise<WorkspaceStore> {
    const root = WorkspaceStore.resolveRoot(dir);
    await fs.mkdir(path.join(root, COLLECTIONS_DIR), { recursive: true });
    await fs.mkdir(path.join(root, ENVIRONMENTS_DIR), { recursive: true });
    await fs.mkdir(path.join(root, GLOBALS_DIR), { recursive: true });
    const globals = path.join(root, GLOBALS_DIR, GLOBALS_FILE);
    if (!existsSync(globals) && !existsSync(path.join(root, GLOBALS_DIR, LEGACY_GLOBALS_FILE))) {
      await writeFileAtomic(globals, globalsToYaml([{ key: "appName", value: "Yamlet", enabled: true }]));
    }
    return WorkspaceStore.open(root, options);
  }

  get rootPath(): string {
    return this.workspace.rootPath;
  }

  async reload(): Promise<YamletWorkspace> {
    return this.enqueue(async () => {
      this.workspace = await loadWorkspace(this.workspace.rootPath);
      if (this.local) applyLocalValues(this.workspace, this.local);
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
      const display = name.trim() || "New Collection";
      const dir = uniqueDirectoryPath(ws.collectionsPath, fileSafeName(display, "New Collection"));
      await fs.mkdir(dir, { recursive: true });
      const c = newCollection({
        name: display,
        directoryPath: dir,
        filePath: path.join(dir, DEFINITION_FILE),
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
      if (patch.name !== undefined && patch.name.trim()) c.name = patch.name;
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
      await this.local?.set(collectionScope(c.id), undefined);
      this.workspace.collections = this.workspace.collections.filter((x) => x !== c);
      return c;
    });
  }

  async duplicateCollection(id: string): Promise<YamletCollection> {
    return this.enqueue(async () => {
      const src = this.requireCollection(id);
      if (!src.directoryPath) throw new Error("Collection has no directory");
      const name = copyName(src.name);
      const dir = uniqueDirectoryPath(this.workspace.collectionsPath, fileSafeName(name, "Collection"));
      // Copying the directory keeps non-modeled files and unknown YAML keys.
      await fs.cp(src.directoryPath, dir, { recursive: true });
      const c = structuredClone(src);
      repathTree(c, src.directoryPath, dir);
      freshIds(c);
      c.name = name;
      c.filePath = path.join(dir, DEFINITION_FILE);
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
      const dir = uniqueDirectoryPath(ws.collectionsPath, fileSafeName(c.name, "Imported Collection"));
      await fs.mkdir(dir, { recursive: true });
      c.directoryPath = dir;
      c.filePath = path.join(dir, DEFINITION_FILE);
      c.order = nextOrder(ws.collections);
      // uniqueFilePath checks the disk, so each request is written as soon as it is placed.
      const placeAndWrite = async (node: YamletCollection | YamletFolder, nodeDir: string) => {
        for (const [i, r] of node.requests.entries()) {
          r.order = (i + 1) * ORDER_STEP;
          r.sourceFilePath = uniqueFilePath(nodeDir, fileSafeName(r.name, "New Request"), REQUEST_SUFFIX);
          await writeFileAtomic(r.sourceFilePath, requestToYaml(r, undefined, r.sourceFilePath));
        }
        for (const [i, f] of node.folders.entries()) {
          f.order = (i + 1) * ORDER_STEP;
          f.directoryPath = uniqueDirectoryPath(nodeDir, fileSafeName(f.name, "New Folder"));
          await fs.mkdir(f.directoryPath, { recursive: true });
          await writeFileAtomic(path.join(f.directoryPath, DEFINITION_FILE), folderToYaml(f, undefined, path.basename(f.directoryPath)));
          await placeAndWrite(f, f.directoryPath);
        }
      };
      await placeAndWrite(c, dir);
      await this.saveLocal(collectionScope(c.id), c.variables);
      await writeFileAtomic(c.filePath, collectionToYaml(c));
      ws.collections.push(c);
      return c;
    });
  }

  // ---- Folders -------------------------------------------------------------

  async createFolder(collectionId: string, parentFolderId: string | null, name: string): Promise<YamletFolder> {
    return this.enqueue(async () => {
      const { node, dir } = this.container(collectionId, parentFolderId);
      const display = name.trim() || "New Folder";
      const folderDir = uniqueDirectoryPath(dir, fileSafeName(display, "New Folder"));
      await fs.mkdir(folderDir, { recursive: true });
      const f = newFolder({ name: display, directoryPath: folderDir, order: nextOrder(node.folders) });
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
      if (patch.name !== undefined && patch.name.trim()) f.name = patch.name;
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
      const dir = uniqueDirectoryPath(path.dirname(srcDir), fileSafeName(name, "Folder"));
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
      const file = uniqueFilePath(dir, fileSafeName(name, "New Request"), REQUEST_SUFFIX);
      const id = init?.id && !this.idInUse(init.id) ? init.id : newId();
      const r = newRequest({ ...init, id, name, sourceFilePath: file, order: nextOrder(node.requests) });
      r.method = (r.method || "GET").toUpperCase();
      await writeFileAtomic(file, requestToYaml(r, undefined, file));
      node.requests.push(r);
      return r;
    });
  }

  /** Replaces a request by id and rewrites its file, renaming the file to match the name. */
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
      if (!existing.sourceFilePath) throw new Error("Request has no file path");
      if (!updated.name.trim()) updated.name = existing.name;
      await this.writeRequest(updated);
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
      r.sourceFilePath = uniqueFilePath(path.dirname(src.sourceFilePath!), fileSafeName(r.name, "New Request"), REQUEST_SUFFIX);
      await writeFileAtomic(r.sourceFilePath, requestToYaml(r, await readIfExists(src.sourceFilePath), r.sourceFilePath));
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
          const dest = uniqueFilePath(target.dir, fileSafeName(r.name, "New Request"), REQUEST_SUFFIX);
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
      const order = (i + 1) * ORDER_STEP;
      if (r.order === order && existsSync(r.sourceFilePath ?? "")) continue;
      r.order = order;
      if (r.sourceFilePath) await this.writeRequest(r);
    }
    for (const [i, f] of node.folders.entries()) {
      const order = (i + 1) * ORDER_STEP;
      if (f.order === order && existsSync(path.join(f.directoryPath ?? "", DEFINITION_FILE))) continue;
      f.order = order;
      await this.writeFolder(f);
    }
  }

  // ---- Environments and globals --------------------------------------------

  async createEnvironment(name: string): Promise<YamletEnvironment> {
    return this.enqueue(async () => {
      const ws = this.workspace;
      const display = name.trim() || "New Environment";
      const file = uniqueFilePath(ws.environmentsPath, fileSafeName(display, "New Environment"), ENVIRONMENT_SUFFIX);
      const env = newEnvironment({ name: display, filePath: file });
      await writeFileAtomic(file, environmentToYaml(env));
      ws.environments.push(env);
      return env;
    });
  }

  async importEnvironment(imported: YamletEnvironment): Promise<YamletEnvironment> {
    return this.enqueue(async () => {
      const ws = this.workspace;
      const env = { ...structuredClone(imported), id: newId(), name: imported.name?.trim() || "Imported Environment" };
      env.filePath = uniqueFilePath(ws.environmentsPath, fileSafeName(env.name, "Imported Environment"), ENVIRONMENT_SUFFIX);
      await this.saveLocal(environmentScope(env.id), env.variables);
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
      const name = env.name.trim() ? env.name : existing.name;
      const dir = existing.filePath ? path.dirname(existing.filePath) : this.workspace.environmentsPath;
      const target = uniqueFilePath(dir, fileSafeName(name, "New Environment"), ENVIRONMENT_SUFFIX, existing.filePath);
      const original = await readIfExists(existing.filePath);
      if (existing.filePath && target !== existing.filePath && existsSync(existing.filePath)) await fs.rename(existing.filePath, target);
      const updated: YamletEnvironment = { ...structuredClone(env), name, filePath: target };
      await this.saveLocal(environmentScope(updated.id), updated.variables);
      await writeFileAtomic(target, environmentToYaml(updated, original));
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
      await this.local?.set(environmentScope(env.id), undefined);
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
      env.filePath = uniqueFilePath(this.workspace.environmentsPath, fileSafeName(env.name, "Environment"), ENVIRONMENT_SUFFIX);
      await this.saveLocal(environmentScope(env.id), env.variables);
      await writeFileAtomic(env.filePath, environmentToYaml(env, await readIfExists(src.filePath)));
      list.splice(list.indexOf(src) + 1, 0, env);
      return env;
    });
  }

  async saveGlobals(vars: Variable[]): Promise<Variable[]> {
    return this.enqueue(async () => {
      const file = path.join(this.workspace.globalsPath, GLOBALS_FILE);
      const legacy = path.join(this.workspace.globalsPath, LEGACY_GLOBALS_FILE);
      await this.saveLocal(GLOBALS_SCOPE, vars);
      await writeFileAtomic(file, globalsToYaml(vars, (await readIfExists(file)) ?? (await readIfExists(legacy))));
      await fs.rm(legacy, { force: true });
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

  /** Stores a scope's local values (the YAML gets blanks for them). */
  private async saveLocal(scope: LocalScope, vars: Variable[]): Promise<void> {
    if (!this.local) return;
    const values: Record<string, string> = {};
    for (const v of vars) if (v.local && v.key) values[v.key] = v.value ?? "";
    await this.local.set(scope, values);
  }

  /** Writes a request, first renaming its file to `<name>.request.yaml` (older names move over). */
  private async writeRequest(r: YamletRequest): Promise<void> {
    const file = r.sourceFilePath;
    if (!file) return;
    const original = await readIfExists(file);
    const target = uniqueFilePath(path.dirname(file), fileSafeName(r.name, "New Request"), REQUEST_SUFFIX, file);
    if (target !== file && existsSync(file)) await fs.rename(file, target);
    r.sourceFilePath = target;
    await writeFileAtomic(target, requestToYaml(r, original, target));
  }

  /** Writes `.resources/definition.yaml` (renaming the directory to match the name) and drops a legacy collection.yaml. */
  private async writeCollection(c: YamletCollection): Promise<void> {
    if (!c.directoryPath) throw new Error("Collection has no directory");
    await this.renameNodeDir(c, this.workspace.collectionsPath, fileSafeName(c.name, "New Collection"));
    const file = path.join(c.directoryPath, DEFINITION_FILE);
    const legacy = path.join(c.directoryPath, LEGACY_COLLECTION_FILE);
    const original = (await readIfExists(file)) ?? (await readIfExists(legacy));
    c.filePath = file;
    await this.saveLocal(collectionScope(c.id), c.variables);
    await writeFileAtomic(file, collectionToYaml(c, original));
    await fs.rm(legacy, { force: true });
  }

  private async writeFolder(f: YamletFolder): Promise<void> {
    if (!f.directoryPath) return;
    await this.renameNodeDir(f, path.dirname(f.directoryPath), fileSafeName(f.name, "New Folder"));
    const dir = f.directoryPath;
    const file = path.join(dir, DEFINITION_FILE);
    const legacy = path.join(dir, LEGACY_FOLDER_FILE);
    const original = (await readIfExists(file)) ?? (await readIfExists(legacy));
    await writeFileAtomic(file, folderToYaml(f, original, path.basename(dir)));
    await fs.rm(legacy, { force: true });
  }

  /** Rewrites every metadata and request file under a node (used after copying a directory). */
  private async writeTree(node: YamletCollection | YamletFolder): Promise<void> {
    if ("variables" in node) await this.writeCollection(node);
    else await this.writeFolder(node);
    for (const r of node.requests) await this.writeRequest(r);
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

  const globalsText =
    (await readIfExists(path.join(ws.globalsPath, GLOBALS_FILE))) ?? (await readIfExists(path.join(ws.globalsPath, LEGACY_GLOBALS_FILE)));
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
    filePath: path.join(dir, DEFINITION_FILE),
  });
  // A legacy collection.yaml (still there until the collection is saved) overrides the definition.
  const definition = await readIfExists(c.filePath);
  if (definition) applyCollectionDefinition(c, loadYaml(definition));
  const metadata = await readIfExists(path.join(dir, LEGACY_COLLECTION_FILE));
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
    for (const file of [DEFINITION_FILE, LEGACY_FOLDER_FILE]) {
      const meta = await readIfExists(path.join(dir, file));
      if (!meta) continue;
      try {
        applyFolderMetadata(f, loadYaml(meta));
      } catch {
        // A malformed definition falls back to the directory name and order 0.
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
    if (lower === LEGACY_COLLECTION_FILE || lower === LEGACY_FOLDER_FILE) continue;
    const file = path.join(dir, entry.name);
    try {
      const raw = loadYaml(await fs.readFile(file, "utf8"));
      if (!isObj(raw)) continue;
      // Other kinds of item (other protocols) are left alone on disk.
      if (raw.$kind !== undefined && String(raw.$kind) !== REQUEST_KIND) continue;
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

/** Puts stored values into `local` variables. A blank file value with a stored one is local too
 * (another tool may have dropped the `local` flag when it saved the file). */
function applyLocalValues(ws: YamletWorkspace, local: LocalValues): void {
  const overlay = (vars: Variable[], stored: Record<string, string> | undefined) => {
    if (!stored) return;
    for (const v of vars) {
      if (!Object.hasOwn(stored, v.key) || (!v.local && v.value)) continue;
      v.value = stored[v.key];
      v.local = true;
    }
  };
  for (const e of ws.environments) overlay(e.variables, local.get(environmentScope(e.id)));
  for (const c of ws.collections) overlay(c.variables, local.get(collectionScope(c.id)));
  overlay(ws.globals, local.get(GLOBALS_SCOPE));
}
