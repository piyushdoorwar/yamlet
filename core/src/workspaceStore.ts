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
import { createHash } from "node:crypto";
import { existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import {
  newCollection,
  newEnvironment,
  newFolder,
  newId,
  newRequest,
  type Auth,
  type Variable,
  type YamletCollection,
  type YamletEnvironment,
  type YamletFolder,
  type YamletRequest,
  type YamletWorkspace,
} from "./models.js";
import { collectionScope, currentScope, environmentScope, GLOBALS_SCOPE, TOKENS_SCOPE, type LocalScope, type LocalValues } from "./localValues.js";
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
  /**
   * Each file's text as Yamlet last read or wrote it, so a change made on disk since
   * (a git pull, another editor) is never overwritten unseen; and files that didn't parse.
   */
  private track: LoadTrack;

  private constructor(workspace: YamletWorkspace, track: LoadTrack, options: StoreOptions) {
    this.workspace = workspace;
    this.track = track;
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
    const track: LoadTrack = { seen: new Map(), broken: new Map() };
    return new WorkspaceStore(await loadWorkspace(root, track), track, options);
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
      this.track = { seen: new Map(), broken: new Map() };
      this.workspace = await loadWorkspace(this.workspace.rootPath, this.track);
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
      if (c.directoryPath) {
        await fs.rm(c.directoryPath, { recursive: true, force: true });
        this.forget(c.directoryPath);
      }
      await this.dropLocal(collectionScope(c.id));
      await this.dropTokens(c);
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
      this.forget(dir);
      await fs.cp(src.directoryPath, dir, { recursive: true });
      const c = structuredClone(src);
      repathTree(c, src.directoryPath, dir);
      freshIds(c);
      c.name = name;
      c.filePath = path.join(dir, DEFINITION_FILE);
      c.order = nextOrder(this.workspace.collections);
      await this.writeCopy(c, dir);
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
          const text = requestToYaml(r, undefined, r.sourceFilePath);
          await this.writeFile(r.sourceFilePath, text);
          r.baseHash = textHash(text);
          await this.saveToken(r.id, r.auth);
        }
        for (const [i, f] of node.folders.entries()) {
          f.order = (i + 1) * ORDER_STEP;
          f.directoryPath = uniqueDirectoryPath(nodeDir, fileSafeName(f.name, "New Folder"));
          await fs.mkdir(f.directoryPath, { recursive: true });
          await this.writeFile(path.join(f.directoryPath, DEFINITION_FILE), folderToYaml(f, undefined, path.basename(f.directoryPath)));
          await this.saveToken(f.id, f.auth);
          await placeAndWrite(f, f.directoryPath);
        }
      };
      await placeAndWrite(c, dir);
      await this.saveLocal(collectionScope(c.id), c.variables);
      await this.writeFile(c.filePath, collectionToYaml(c));
      await this.saveToken(c.id, c.auth);
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

  async updateFolder(id: string, patch: { name?: string; description?: string; auth?: Auth; preRequestScript?: string; postResponseScript?: string }): Promise<YamletFolder> {
    return this.enqueue(async () => {
      const hit = this.locateFolder(id);
      if (!hit) throw new Error(`Folder not found: ${id}`);
      const f = hit.folder;
      if (patch.name !== undefined && patch.name.trim()) f.name = patch.name;
      if (patch.description !== undefined) f.description = patch.description;
      if (patch.auth !== undefined) f.auth = patch.auth;
      if (patch.preRequestScript !== undefined) f.preRequestScript = patch.preRequestScript;
      if (patch.postResponseScript !== undefined) f.postResponseScript = patch.postResponseScript;
      await this.writeFolder(f);
      return f;
    });
  }

  async deleteFolder(id: string): Promise<YamletFolder> {
    return this.enqueue(async () => {
      const hit = this.locateFolder(id);
      if (!hit) throw new Error(`Folder not found: ${id}`);
      if (hit.folder.directoryPath) {
        await fs.rm(hit.folder.directoryPath, { recursive: true, force: true });
        this.forget(hit.folder.directoryPath);
      }
      await this.dropTokens(hit.folder);
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
      this.forget(dir);
      await fs.cp(srcDir, dir, { recursive: true });
      const f = structuredClone(src);
      repathTree(f, srcDir, dir);
      freshIds(f);
      f.name = name;
      await this.writeCopy(f, dir);
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
      const text = requestToYaml(r, undefined, file);
      await this.writeFile(file, text);
      r.baseHash = textHash(text);
      await this.saveToken(r.id, r.auth);
      node.requests.push(r);
      return r;
    });
  }

  /**
   * Replaces a request by id and rewrites its file, renaming the file to match the name.
   * `force` overwrites a file that changed on disk since it was read.
   */
  async saveRequest(request: YamletRequest, opts: { force?: boolean } = {}): Promise<YamletRequest> {
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
      // The copy names the file it was based on: a file changed since (a git pull, even one
      // Yamlet has reloaded) is not overwritten unless the user chose to.
      let force = opts.force === true;
      if (!force && request.baseHash) {
        const now = await readIfExists(existing.sourceFilePath);
        if (now !== undefined && textHash(now) !== request.baseHash) {
          throw conflict(`${this.relPath(existing.sourceFilePath)} changed on disk since this request was opened (a git pull or another editor?). Overwrite it, or use the disk version.`, "changed");
        }
        force = now !== undefined && !this.track.broken.has(existing.sourceFilePath);
      }
      await this.writeRequest(updated, force);
      hit.list[hit.list.indexOf(existing)] = updated;
      return updated;
    });
  }

  async deleteRequest(id: string): Promise<YamletRequest> {
    return this.enqueue(async () => {
      const hit = this.locateRequest(id);
      if (!hit) throw new Error(`Request not found: ${id}`);
      if (hit.request.sourceFilePath) {
        await fs.rm(hit.request.sourceFilePath, { force: true });
        this.forget(hit.request.sourceFilePath);
      }
      await this.dropTokens(hit.request);
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
      const text = requestToYaml(r, await readIfExists(src.sourceFilePath), r.sourceFilePath);
      await this.writeFile(r.sourceFilePath, text);
      r.baseHash = textHash(text);
      await this.saveToken(r.id, r.auth);
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
          this.moved(r.sourceFilePath, dest);
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
        this.moved(from, dest);
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
    // Only the order changes here: a sibling edited on disk since (a git pull) is re-read
    // first so its new content is kept, and one that doesn't parse is left as it is.
    for (const [i, r0] of node.requests.entries()) {
      let r = r0;
      const order = (i + 1) * ORDER_STEP;
      if (r.order === order && existsSync(r.sourceFilePath ?? "")) continue;
      const file = r.sourceFilePath;
      if (!file || this.track.broken.has(file)) continue;
      const fresh = await this.changedOnDisk(file);
      if (fresh !== undefined) {
        try {
          r = { ...requestFromDto(loadYaml(fresh), file), id: r.id, baseHash: textHash(fresh) };
          r.auth = withTokensOf(r0.auth, r.auth);
          node.requests[i] = r;
        } catch (e) {
          this.track.broken.set(file, parseMessage(e));
          continue;
        }
      }
      r.order = order;
      await this.writeRequest(r);
    }
    for (const [i, f] of node.folders.entries()) {
      const order = (i + 1) * ORDER_STEP;
      const file = path.join(f.directoryPath ?? "", DEFINITION_FILE);
      if (f.order === order && existsSync(file)) continue;
      if (this.track.broken.has(file) || this.track.broken.has(path.join(f.directoryPath ?? "", LEGACY_FOLDER_FILE))) continue;
      const fresh = await this.changedOnDisk(file);
      if (fresh !== undefined) {
        try {
          const before = f.auth;
          applyFolderMetadata(f, loadYaml(fresh));
          f.auth = withTokensOf(before, f.auth);
        } catch (e) {
          this.track.broken.set(file, parseMessage(e));
          continue;
        }
      }
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
      await this.writeFile(file, environmentToYaml(env));
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
      await this.writeFile(env.filePath, environmentToYaml(env));
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
      if (existing.filePath) await this.assertWritable(existing.filePath);
      const original = await readIfExists(existing.filePath);
      if (existing.filePath && target !== existing.filePath && existsSync(existing.filePath)) {
        await fs.rename(existing.filePath, target);
        this.moved(existing.filePath, target);
      }
      const updated: YamletEnvironment = { ...structuredClone(env), name, filePath: target };
      await this.saveLocal(environmentScope(updated.id), updated.variables);
      await this.writeFile(target, environmentToYaml(updated, original));
      list[idx] = updated;
      return updated;
    });
  }

  async deleteEnvironment(id: string): Promise<YamletEnvironment> {
    return this.enqueue(async () => {
      const list = this.workspace.environments;
      const env = list.find((e) => e.id === id);
      if (!env) throw new Error(`Environment not found: ${id}`);
      if (env.filePath) {
        await fs.rm(env.filePath, { force: true });
        this.forget(env.filePath);
      }
      await this.dropLocal(environmentScope(env.id));
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
      await this.writeFile(env.filePath, environmentToYaml(env, await readIfExists(src.filePath)));
      list.splice(list.indexOf(src) + 1, 0, env);
      return env;
    });
  }

  async saveGlobals(vars: Variable[]): Promise<Variable[]> {
    return this.enqueue(async () => {
      const file = path.join(this.workspace.globalsPath, GLOBALS_FILE);
      const legacy = path.join(this.workspace.globalsPath, LEGACY_GLOBALS_FILE);
      await this.assertWritable(legacy);
      await this.saveLocal(GLOBALS_SCOPE, vars);
      await this.writeFile(file, globalsToYaml(vars, (await readIfExists(file)) ?? (await readIfExists(legacy))));
      await fs.rm(legacy, { force: true });
      this.track.seen.set(legacy, ABSENT);
      this.workspace.globals = structuredClone(vars);
      return this.workspace.globals;
    });
  }

  /**
   * A new OAuth 2.0 token for a collection or folder: kept in memory and the data folder
   * only, so the YAML (which never holds tokens) isn't rewritten.
   */
  async setToken(id: string, t: { accessToken: string; refreshToken?: string; expiresAt?: number }): Promise<void> {
    return this.enqueue(async () => {
      const node = this.findCollection(id) ?? this.locateFolder(id)?.folder;
      const auth = node?.auth;
      if (!node || auth?.type !== "oauth2") return;
      node.auth = { ...auth, oauth2: { ...auth.oauth2, accessToken: t.accessToken, refreshToken: t.refreshToken || auth.oauth2.refreshToken, expiresAt: t.expiresAt } };
      await this.saveToken(id, node.auth);
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
    this.moved(from, to);
  }

  /**
   * Stores a scope's local values (the YAML gets blanks for them) and current values (the
   * YAML keeps the initial ones). An override equal to the file value is dropped.
   */
  private async saveLocal(scope: LocalScope, vars: Variable[]): Promise<void> {
    const values: Record<string, string> = {};
    const current: Record<string, string> = {};
    for (const v of vars) {
      if (v.local || v.initialValue === v.value) delete v.initialValue;
      if (!v.key) continue;
      if (v.local) values[v.key] = v.value ?? "";
      else if (v.initialValue !== undefined) current[v.key] = v.value ?? "";
    }
    if (!this.local) return;
    await this.local.set(scope, values);
    await this.local.set(currentScope(scope), current);
  }

  private async dropLocal(scope: LocalScope): Promise<void> {
    await this.local?.set(scope, undefined);
    await this.local?.set(currentScope(scope), undefined);
  }

  // ---- Guarded writes ---------------------------------------------------------

  private relPath(file: string): string {
    return path.relative(this.workspace.rootPath, file).split(path.sep).join("/");
  }

  /**
   * Refuses to write over a file that didn't parse, or that changed on disk since Yamlet
   * read or wrote it (unless `force`). Errors carry status 409 for the API.
   */
  private async assertWritable(file: string, force = false): Promise<void> {
    const broken = this.track.broken.get(file);
    if (broken !== undefined && !force) {
      throw conflict(`${this.relPath(file)} couldn't be read (${broken}), so Yamlet won't overwrite it. Fix the file, for example a Git merge conflict, then reload the workspace.`, "broken");
    }
    const known = this.track.seen.get(file);
    if (known === undefined || force) return;
    const now = await readIfExists(file);
    if (now !== undefined && now !== known) {
      // (ABSENT: the file appeared since; anything else: its text changed.)
      throw conflict(`${this.relPath(file)} changed on disk since Yamlet loaded it (a git pull or another editor?). Reload the workspace to use that version, or overwrite it.`, "changed");
    }
  }

  private async writeFile(file: string, content: string, force = false): Promise<void> {
    // Writing what is already there changes nothing, so it is never a conflict.
    if (!this.track.broken.has(file) && (await readIfExists(file)) === content) {
      this.track.seen.set(file, content);
      return;
    }
    await this.assertWritable(file, force);
    await writeFileAtomic(file, content);
    this.track.seen.set(file, content);
    this.track.broken.delete(file);
    if (this.workspace.problems) {
      const rel = this.relPath(file);
      this.workspace.problems = this.workspace.problems.filter((p) => p.path !== rel);
      if (!this.workspace.problems.length) delete this.workspace.problems;
    }
  }

  /** Keeps what was read under a file or directory's new path after a rename. */
  private moved(from: string, to: string): void {
    for (const map of [this.track.seen, this.track.broken]) {
      for (const [file, value] of [...map]) {
        if (file !== from && !file.startsWith(from + path.sep)) continue;
        map.delete(file);
        map.set(to + file.slice(from.length), value);
      }
    }
  }

  /** Forgets what was read under a path that was deleted or is about to be filled by a copy. */
  private forget(target: string): void {
    for (const map of [this.track.seen, this.track.broken]) {
      for (const file of [...map.keys()]) if (file === target || file.startsWith(target + path.sep)) map.delete(file);
    }
  }

  /** Removes the stored tokens of a deleted item and everything under it. */
  private async dropTokens(node: YamletCollection | YamletFolder | YamletRequest): Promise<void> {
    if (!this.local) return;
    const ids: string[] = [];
    const walk = (n: YamletCollection | YamletFolder) => {
      ids.push(n.id);
      for (const r of n.requests) ids.push(r.id);
      for (const f of n.folders) walk(f);
    };
    if ("folders" in node) walk(node);
    else ids.push(node.id);
    const tokens = { ...this.local.get(TOKENS_SCOPE) };
    if (!ids.some((id) => id in tokens)) return;
    for (const id of ids) delete tokens[id];
    await this.local.set(TOKENS_SCOPE, tokens);
  }

  /** The file's text if it changed on disk since Yamlet read it (it is then taken as read). */
  private async changedOnDisk(file: string): Promise<string | undefined> {
    const known = this.track.seen.get(file);
    if (known === undefined) return undefined;
    const now = await readIfExists(file);
    if (now === undefined || now === known) return undefined;
    this.track.seen.set(file, now);
    return now;
  }

  /** Writes a request, first renaming its file to `<name>.request.yaml` (older names move over). */
  private async writeRequest(r: YamletRequest, force = false): Promise<void> {
    const file = r.sourceFilePath;
    if (!file) return;
    const original = await readIfExists(file);
    const target = uniqueFilePath(path.dirname(file), fileSafeName(r.name, "New Request"), REQUEST_SUFFIX, file);
    if (target !== file && existsSync(file)) {
      // Checked before the rename, so a refused write leaves the file where it was.
      await this.assertWritable(file, force);
      await fs.rename(file, target);
      this.moved(file, target);
    }
    r.sourceFilePath = target;
    const text = requestToYaml(r, original, target);
    await this.writeFile(target, text, force);
    r.baseHash = textHash(text);
    await this.saveToken(r.id, r.auth);
  }

  /** Keeps an item's OAuth 2.0 token (and expiry) in the data folder; the YAML never has it. */
  private async saveToken(id: string, auth: Auth | undefined): Promise<void> {
    if (!this.local) return;
    const tokens = { ...this.local.get(TOKENS_SCOPE) };
    const o = auth?.type === "oauth2" ? auth.oauth2 : undefined;
    const entry = o && (o.accessToken || o.refreshToken) ? JSON.stringify({ accessToken: o.accessToken, refreshToken: o.refreshToken, ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}) }) : undefined;
    if (tokens[id] === entry) return;
    if (entry) tokens[id] = entry;
    else delete tokens[id];
    await this.local.set(TOKENS_SCOPE, tokens);
  }

  /** Writes `.resources/definition.yaml` (renaming the directory to match the name) and drops a legacy collection.yaml. */
  private async writeCollection(c: YamletCollection): Promise<void> {
    if (!c.directoryPath) throw new Error("Collection has no directory");
    if (path.basename(c.directoryPath) !== fileSafeName(c.name, "New Collection")) await this.assertWritable(path.join(c.directoryPath, DEFINITION_FILE));
    await this.renameNodeDir(c, this.workspace.collectionsPath, fileSafeName(c.name, "New Collection"));
    const file = path.join(c.directoryPath, DEFINITION_FILE);
    const legacy = path.join(c.directoryPath, LEGACY_COLLECTION_FILE);
    await this.assertWritable(legacy);
    const original = (await readIfExists(file)) ?? (await readIfExists(legacy));
    c.filePath = file;
    await this.saveLocal(collectionScope(c.id), c.variables);
    await this.writeFile(file, collectionToYaml(c, original));
    await this.saveToken(c.id, c.auth);
    await fs.rm(legacy, { force: true });
    this.forget(legacy);
  }

  private async writeFolder(f: YamletFolder): Promise<void> {
    if (!f.directoryPath) return;
    if (path.basename(f.directoryPath) !== fileSafeName(f.name, "New Folder")) await this.assertWritable(path.join(f.directoryPath, DEFINITION_FILE));
    await this.assertWritable(path.join(f.directoryPath, LEGACY_FOLDER_FILE));
    await this.renameNodeDir(f, path.dirname(f.directoryPath), fileSafeName(f.name, "New Folder"));
    const dir = f.directoryPath;
    const file = path.join(dir, DEFINITION_FILE);
    const legacy = path.join(dir, LEGACY_FOLDER_FILE);
    const original = (await readIfExists(file)) ?? (await readIfExists(legacy));
    await this.writeFile(file, folderToYaml(f, original, path.basename(dir)));
    await this.saveToken(f.id, f.auth);
    await fs.rm(legacy, { force: true });
    this.forget(legacy);
  }

  /** Writes a freshly copied tree; if that fails, the copy is removed rather than left behind. */
  private async writeCopy(node: YamletCollection | YamletFolder, dir: string): Promise<void> {
    try {
      await this.writeTree(node);
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.forget(dir);
      throw e;
    }
  }

  /** Rewrites every metadata and request file under a node (used after copying a directory). */
  private async writeTree(node: YamletCollection | YamletFolder): Promise<void> {
    if ("variables" in node) await this.writeCollection(node);
    else await this.writeFolder(node);
    for (const r of node.requests) await this.writeRequest(r);
    for (const f of node.folders) await this.writeTree(f);
  }
}

/** `next` with the OAuth 2.0 token (kept on this machine, not in the file) of `prev`, if both are OAuth. */
function withTokensOf<T extends Auth | undefined>(prev: Auth | undefined, next: T): T {
  if (prev?.type !== "oauth2" || next?.type !== "oauth2") return next;
  const { accessToken, refreshToken, expiresAt } = prev.oauth2;
  return { ...next, oauth2: { ...next.oauth2, accessToken, refreshToken, ...(expiresAt ? { expiresAt } : {}) } };
}

/** Marks a file that wasn't there when Yamlet read the folder (one appearing later is a change). */
const ABSENT = "\u0000absent";

export const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** A refused write; the API answers 409 with the message. */
function conflict(message: string, reason: "broken" | "changed"): Error {
  return Object.assign(new Error(message), { statusCode: 409, reason });
}

// ---------------------------------------------------------------------------
// Loading

/** What a load saw: each file's text as read, and the files that failed to parse. */
interface LoadTrack {
  seen: Map<string, string>;
  broken: Map<string, string>;
}

const parseMessage = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

async function loadWorkspace(root: string, track: LoadTrack): Promise<YamletWorkspace> {
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
      ws.collections.push(await loadCollection(path.join(ws.collectionsPath, entry.name), rel, track));
    } catch (e) {
      // Skip unreadable collections rather than failing the whole open.
      track.broken.set(path.join(ws.collectionsPath, entry.name), parseMessage(e));
    }
  }
  byOrder(ws.collections);

  for (const entry of await listDir(ws.environmentsPath)) {
    if (entry.dir || !isYamlFile(entry.name)) continue;
    const file = path.join(ws.environmentsPath, entry.name);
    try {
      const text = await fs.readFile(file, "utf8");
      const raw = loadYaml(text);
      const env = environmentFromDto(raw, file);
      if (!isObj(raw) || !String(raw.id ?? "").trim()) env.id = stableId("e", rel(file));
      ws.environments.push(env);
      track.seen.set(file, text);
    } catch (e) {
      // Skipped, and listed as a problem.
      track.broken.set(file, parseMessage(e));
    }
  }

  const globalsFile = path.join(ws.globalsPath, GLOBALS_FILE);
  const legacyGlobals = path.join(ws.globalsPath, LEGACY_GLOBALS_FILE);
  const current = await readIfExists(globalsFile);
  const globalsText = current ?? (await readIfExists(legacyGlobals));
  const globalsPath = current !== undefined ? globalsFile : legacyGlobals;
  if (current === undefined) track.seen.set(globalsFile, ABSENT);
  if (globalsText === undefined || current !== undefined) {
    if (!(await readIfExists(legacyGlobals))) track.seen.set(legacyGlobals, ABSENT);
  }
  if (globalsText) {
    try {
      ws.globals = globalsFromYaml(globalsText);
      track.seen.set(globalsPath, globalsText);
    } catch (e) {
      ws.globals = [];
      // Saving globals would replace a file Yamlet couldn't read: both paths are held back.
      track.broken.set(globalsFile, parseMessage(e));
      if (globalsPath !== globalsFile) track.broken.set(globalsPath, parseMessage(e));
    }
  }

  ensureUniqueIds(ws, rel);
  if (track.broken.size) ws.problems = [...track.broken].map(([file, message]) => ({ path: rel(file), message }));
  return ws;
}

async function loadCollection(dir: string, rel: (p: string) => string, track: LoadTrack): Promise<YamletCollection> {
  const c = newCollection({
    id: stableId("c", rel(dir)),
    name: path.basename(dir),
    directoryPath: dir,
    filePath: path.join(dir, DEFINITION_FILE),
  });
  // A legacy collection.yaml (still there until the collection is saved) overrides the definition.
  // A definition that doesn't parse (say, Git conflict markers) still shows the requests,
  // with the file held back from writes until it's fixed.
  const read = async (file: string, apply: (raw: unknown) => void) => {
    const text = await readIfExists(file);
    if (text === undefined) track.seen.set(file, ABSENT);
    if (!text) return;
    try {
      apply(loadYaml(text));
      track.seen.set(file, text);
    } catch (e) {
      track.broken.set(file, parseMessage(e));
    }
  };
  await read(c.filePath!, (raw) => applyCollectionDefinition(c, raw));
  await read(path.join(dir, LEGACY_COLLECTION_FILE), (raw) => applyCollectionMetadata(c, raw));
  c.requests = await loadRequests(dir, rel, track);
  c.folders = await loadFolders(dir, rel, track);
  return c;
}

async function loadFolders(parentDir: string, rel: (p: string) => string, track: LoadTrack): Promise<YamletFolder[]> {
  const folders: YamletFolder[] = [];
  for (const entry of await listDir(parentDir)) {
    if (!entry.dir || entry.name.startsWith(".")) continue; // .resources, .git, ...
    const dir = path.join(parentDir, entry.name);
    const f = newFolder({ id: stableId("f", rel(dir)), name: entry.name, directoryPath: dir });
    for (const file of [DEFINITION_FILE, LEGACY_FOLDER_FILE]) {
      const meta = await readIfExists(path.join(dir, file));
      if (meta === undefined) track.seen.set(path.join(dir, file), ABSENT);
      if (!meta) continue;
      try {
        applyFolderMetadata(f, loadYaml(meta));
        track.seen.set(path.join(dir, file), meta);
      } catch (e) {
        // Shown with the directory name and order 0; the file is held back from writes.
        track.broken.set(path.join(dir, file), parseMessage(e));
      }
    }
    f.requests = await loadRequests(dir, rel, track);
    f.folders = await loadFolders(dir, rel, track);
    folders.push(f);
  }
  return byOrder(folders);
}

async function loadRequests(dir: string, rel: (p: string) => string, track: LoadTrack): Promise<YamletRequest[]> {
  const requests: YamletRequest[] = [];
  for (const entry of await listDir(dir)) {
    if (entry.dir || !isYamlFile(entry.name)) continue;
    const lower = entry.name.toLowerCase();
    if (lower === LEGACY_COLLECTION_FILE || lower === LEGACY_FOLDER_FILE) continue;
    const file = path.join(dir, entry.name);
    try {
      const text = await fs.readFile(file, "utf8");
      const raw = loadYaml(text);
      if (!isObj(raw)) continue;
      // Other kinds of item (other protocols) are left alone on disk.
      if (raw.$kind !== undefined && String(raw.$kind) !== REQUEST_KIND) continue;
      const r = requestFromDto(raw, file);
      if (!String(raw.id ?? "").trim()) r.id = stableId("r", rel(file));
      r.baseHash = textHash(text);
      requests.push(r);
      track.seen.set(file, text);
    } catch (e) {
      // Skipped, and listed as a problem.
      track.broken.set(file, parseMessage(e));
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
 * (another tool may have dropped the `local` flag when it saved the file). Then current
 * values go over the file values they override. */
function applyLocalValues(ws: YamletWorkspace, local: LocalValues): void {
  const overlay = (vars: Variable[], scope: LocalScope) => {
    const stored = local.get(scope);
    const current = local.get(currentScope(scope));
    for (const v of vars) {
      if (stored && Object.hasOwn(stored, v.key) && (v.local || !v.value)) {
        v.value = stored[v.key];
        v.local = true;
      } else if (current && Object.hasOwn(current, v.key) && !v.local && current[v.key] !== v.value) {
        v.initialValue = v.value;
        v.value = current[v.key];
      }
    }
  };
  for (const e of ws.environments) overlay(e.variables, environmentScope(e.id));
  for (const c of ws.collections) overlay(c.variables, collectionScope(c.id));
  overlay(ws.globals, GLOBALS_SCOPE);

  // OAuth 2.0 tokens kept on this machine go back onto the auth they belong to.
  const tokens = local.get(TOKENS_SCOPE);
  if (!tokens) return;
  const withToken = (id: string, auth: Auth | undefined) => {
    if (auth?.type !== "oauth2" || !tokens[id]) return;
    try {
      const t = JSON.parse(tokens[id]) as { accessToken?: string; refreshToken?: string; expiresAt?: number };
      auth.oauth2 = { ...auth.oauth2, accessToken: t.accessToken ?? "", refreshToken: t.refreshToken ?? "", ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}) };
    } catch {
      // An unreadable entry is ignored.
    }
  };
  const walk = (node: YamletCollection | YamletFolder) => {
    withToken(node.id, node.auth);
    for (const r of node.requests) withToken(r.id, r.auth);
    for (const f of node.folders) walk(f);
  };
  ws.collections.forEach(walk);
}
