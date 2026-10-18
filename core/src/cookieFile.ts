// Keeps each workspace's cookie jar in <dataDir>/cookies.json so cookies survive restarts.
// Cookies synced from the browser are left out: the extension sends them again.
import { promises as fs } from "node:fs";
import path from "node:path";
import { CookieJar, type StoredCookie } from "./cookieJar.js";

export const COOKIES_FILE = "cookies.json";
const SAVE_DELAY_MS = 300;

interface FileShape {
  version: 1;
  workspaces: Record<string, StoredCookie[]>;
}

export class CookieFile {
  private data: FileShape = { version: 1, workspaces: {} };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly jars = new Map<string, CookieJar>();

  private constructor(readonly filePath: string) {}

  static async open(dataDir: string): Promise<CookieFile> {
    const file = new CookieFile(path.join(dataDir, COOKIES_FILE));
    try {
      const parsed = JSON.parse(await fs.readFile(file.filePath, "utf8")) as Partial<FileShape>;
      if (parsed && typeof parsed.workspaces === "object" && parsed.workspaces) file.data.workspaces = parsed.workspaces;
    } catch {
      // Missing or unreadable: start empty (cookies are a cache, not data to guard).
    }
    return file;
  }

  /** The jar for a workspace root, loaded from the file and saved on every change. */
  jarFor(root: string): CookieJar {
    let jar = this.jars.get(root);
    if (jar) return jar;
    jar = CookieJar.fromJSON(this.data.workspaces[root] ?? []);
    const j = jar;
    jar.onChange(() => {
      const kept = j.list().filter((c) => !c.browserSite);
      if (kept.length) this.data.workspaces[root] = kept;
      else delete this.data.workspaces[root];
      this.schedule();
    });
    this.jars.set(root, jar);
    return jar;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Writes now (also used before shutdown and in tests). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const text = `${JSON.stringify(this.data, null, 2)}\n`;
    const write = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      // Owner-only: session cookies are credentials.
      await fs.writeFile(tmp, text, { mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    };
    this.writing = this.writing.then(write, write);
    await this.writing;
  }
}
