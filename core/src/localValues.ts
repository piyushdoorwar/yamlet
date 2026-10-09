// Variable values kept on this machine instead of in the workspace YAML. A variable marked
// `local` is written to its file with a blank value; the real value lives here, in one JSON
// file in Yamlet's data folder (the /data volume in the container), keyed by workspace root
// and scope. Writes are atomic and serialized, and the file is readable by its owner only.
import { promises as fs } from "node:fs";
import path from "node:path";

/** `environment:<id>`, `collection:<id>` or `globals`. */
export type LocalScope = string;

export const environmentScope = (id: string): LocalScope => `environment:${id}`;
export const collectionScope = (id: string): LocalScope => `collection:${id}`;
export const GLOBALS_SCOPE: LocalScope = "globals";

/** One workspace's view of the local values. */
export interface LocalValues {
  get(scope: LocalScope): Record<string, string> | undefined;
  /** Replaces a scope's values; an empty or missing map removes the scope. */
  set(scope: LocalScope, values: Record<string, string> | undefined): Promise<void>;
}

interface FileShape {
  version: 1;
  workspaces: Record<string, Record<LocalScope, Record<string, string>>>;
}

export const LOCAL_VALUES_FILE = "local-values.json";

export class LocalValuesFile {
  private data: FileShape = { version: 1, workspaces: {} };
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly filePath: string) {}

  /** Loads `<dataDir>/local-values.json` (missing is fine; unreadable JSON is kept aside, not overwritten). */
  static async open(dataDir: string): Promise<LocalValuesFile> {
    const store = new LocalValuesFile(path.join(dataDir, LOCAL_VALUES_FILE));
    let text: string | undefined;
    try {
      text = await fs.readFile(store.filePath, "utf8");
    } catch {
      return store;
    }
    try {
      const parsed = JSON.parse(text) as Partial<FileShape>;
      if (parsed && typeof parsed.workspaces === "object" && parsed.workspaces) store.data.workspaces = parsed.workspaces;
    } catch {
      await fs.copyFile(store.filePath, `${store.filePath}.corrupt-${Date.now()}`).catch(() => undefined);
    }
    return store;
  }

  forWorkspace(root: string): LocalValues {
    return {
      get: (scope) => {
        const hit = this.data.workspaces[root]?.[scope];
        return hit ? { ...hit } : undefined;
      },
      set: (scope, values) => this.update(root, scope, values),
    };
  }

  private update(root: string, scope: LocalScope, values: Record<string, string> | undefined): Promise<void> {
    const ws = this.data.workspaces[root] ?? {};
    const before = JSON.stringify(ws[scope] ?? null);
    if (values && Object.keys(values).length) ws[scope] = { ...values };
    else delete ws[scope];
    if (JSON.stringify(ws[scope] ?? null) === before) return this.queue.then(() => undefined);
    if (Object.keys(ws).length) this.data.workspaces[root] = ws;
    else delete this.data.workspaces[root];
    const snapshot = JSON.stringify(this.data, null, 2) + "\n";
    const run = this.queue.then(() => writePrivate(this.filePath, snapshot));
    this.queue = run.catch(() => undefined);
    return run;
  }
}

async function writePrivate(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}
