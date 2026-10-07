import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { StoredCookie } from "../../../core/src/cookieJar.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";
import { isExtensionRequest } from "../security.js";

// A revoked pairing keeps its id (secret cleared) so its extension is told it was
// disconnected on purpose (403) rather than forgotten, e.g. a lost /data volume (401).
interface Pairing { id: string; secret: string; workspace: string; createdAt: string; revokedAt?: string }
interface Pending { workspace: string; expires: number }
interface BrowserCookie {
  name: string; value: string; domain: string; path: string; hostOnly: boolean;
  secure: boolean; httpOnly: boolean; sameSite?: string; expirationDate?: number;
}

const pending = new Map<string, Pending>();
const siteMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const extensionRequest = (req: FastifyRequest) => isExtensionRequest(typeof req.headers.origin === "string" ? req.headers.origin : undefined, req.url);

/** Chrome's sameSite values in Set-Cookie spelling. */
const SAME_SITE: Record<string, string | undefined> = { no_restriction: "None", lax: "Lax", strict: "Strict", unspecified: undefined };

function purgeExpiredCodes(): void {
  const now = Date.now();
  for (const [code, entry] of pending) if (entry.expires < now) pending.delete(code);
}

export function interceptorRoutes(app: FastifyInstance, { config, workspaces }: Deps): void {
  const dir = config.interceptorDataDir ?? join(config.browseRoot, ".yamlet-private");
  const file = join(dir, "interceptor-pairings.json");
  // Read from disk every time: the file is small, and another Yamlet process on this
  // machine may share it (outside the container the data dir is per user, not per port).
  const pairings = async (): Promise<Pairing[]> => {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const data: unknown = JSON.parse(text);
      return Array.isArray(data) ? data.filter((x): x is Pairing => x && typeof x.id === "string" && typeof x.secret === "string" && typeof x.workspace === "string") : [];
    } catch {
      // A damaged file (e.g. cut short by a power loss) is set aside so pairing works
      // again; browsers re-pair on their own after the 401 this causes.
      await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      return [];
    }
  };
  /** Applies `change` to the current pairings and writes them durably. */
  const update = async (change: (list: Pairing[]) => Pairing[]): Promise<void> => {
    const next = change(await pairings());
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  };
  /** Finds a pairing and checks an encrypted request from it; returns the plaintext. */
  const openEnvelope = async (body: { pairingId?: string; iv?: string; ciphertext?: string } | undefined): Promise<{ pair: Pairing; data: Record<string, unknown> }> => {
    if (typeof body?.pairingId !== "string" || typeof body?.iv !== "string" || typeof body?.ciphertext !== "string") throw new HttpError(403, "Invalid pairing.");
    const pair = (await pairings()).find((item) => item.id === body.pairingId);
    // 401 lets the extension pair again on its own; 403 means the user disconnected it.
    if (!pair) throw new HttpError(401, "Unknown pairing.");
    if (pair.revokedAt) throw new HttpError(403, "Pairing was disconnected in Yamlet.");
    try {
      const iv = Buffer.from(body.iv, "base64url");
      const encrypted = Buffer.from(body.ciphertext, "base64url");
      if (iv.length !== 12 || encrypted.length < 17) throw new Error("Invalid encrypted payload");
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(pair.secret, "base64url"), iv);
      decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
      const data: unknown = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8"));
      if (!data || typeof data !== "object") throw new Error("Invalid payload");
      return { pair, data: data as Record<string, unknown> };
    } catch {
      throw new HttpError(400, "Could not decrypt the request.");
    }
  };

  app.post("/api/interceptor/pair/start", async (req) => {
    const { store } = await workspaces.fromHeaders(req.headers);
    purgeExpiredCodes();
    const code = randomBytes(16).toString("base64url");
    pending.set(code, { workspace: store.workspace.rootPath, expires: Date.now() + 5 * 60_000 });
    return { code, expiresInSeconds: 300 };
  });

  app.get("/api/interceptor/status", async (req) => {
    const { store } = await workspaces.fromHeaders(req.headers);
    const active = (await pairings()).filter((pair) => pair.workspace === store.workspace.rootPath && !pair.revokedAt);
    // pairedAt changes with every new pairing, so a page can tell "paired again" apart.
    const pairedAt = active.reduce<string | null>((latest, pair) => (!latest || pair.createdAt > latest ? pair.createdAt : latest), null);
    return { paired: active.length > 0, pairedAt };
  });

  app.delete("/api/interceptor/pairings", async (req) => {
    const { store, cookies } = await workspaces.fromHeaders(req.headers);
    const revokedAt = new Date().toISOString();
    await update((list) => list.map((pair) => (pair.workspace === store.workspace.rootPath && !pair.revokedAt ? { ...pair, secret: "", revokedAt } : pair)));
    cookies.clearBrowserSites();
    return { ok: true };
  });

  app.post<{ Body: { code?: string } }>("/api/interceptor/pair/finish", { bodyLimit: 2048 }, async (req) => {
    if (!extensionRequest(req)) throw new HttpError(403, "Pairing must come from the extension.");
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const entry = code ? pending.get(code) : undefined;
    if (!entry || entry.expires < Date.now()) throw new HttpError(403, "Pairing code expired or invalid.");
    pending.delete(code);
    const pairing: Pairing = { id: randomUUID(), secret: randomBytes(32).toString("base64url"), workspace: entry.workspace, createdAt: new Date().toISOString() };
    await update((list) => [...list, pairing]);
    return { pairingId: pairing.id, secret: pairing.secret };
  });

  app.post<{ Body: { pairingId?: string; iv?: string; ciphertext?: string } }>("/api/interceptor/sync", { bodyLimit: 1024 * 1024 }, async (req) => {
    if (!extensionRequest(req)) throw new HttpError(403, "Sync must come from the extension.");
    const { pair, data } = await openEnvelope(req.body);
    if (typeof data.site !== "string" || !Array.isArray(data.cookies) || data.cookies.length > 1000) throw new HttpError(400, "Invalid cookie snapshot.");
    let site: URL;
    try { site = new URL(data.site); } catch { throw new HttpError(400, "Invalid site."); }
    if (!["http:", "https:"].includes(site.protocol) || site.pathname !== "/" || site.search || site.hash) throw new HttpError(400, "Invalid site.");
    const host = site.hostname.toLowerCase();
    const cookies: Omit<StoredCookie, "createdAt" | "browserSite">[] = [];
    for (const raw of data.cookies as BrowserCookie[]) {
      if (!raw || typeof raw.name !== "string" || !raw.name || /[\x00-\x20;=\x7f]/.test(raw.name) || typeof raw.value !== "string" || raw.value.length > 8192 || /[\r\n]/.test(raw.value) || typeof raw.domain !== "string" || typeof raw.path !== "string" || !raw.path.startsWith("/") || /[\r\n]/.test(raw.path)) throw new HttpError(400, "Invalid cookie.");
      const domain = raw.domain.replace(/^\./, "").toLowerCase();
      if (!siteMatches(host, domain) || (raw.hostOnly && host !== domain)) throw new HttpError(400, "Cookie does not belong to the approved site.");
      if (raw.expirationDate !== undefined && (!Number.isFinite(raw.expirationDate) || raw.expirationDate < 0 || raw.expirationDate > 8_640_000_000_000)) throw new HttpError(400, "Invalid expiration.");
      if (raw.expirationDate !== undefined && raw.expirationDate <= Date.now() / 1000) continue;
      cookies.push({ name: raw.name, value: raw.value, domain, path: raw.path, hostOnly: !!raw.hostOnly, secure: !!raw.secure, httpOnly: !!raw.httpOnly, sameSite: typeof raw.sameSite === "string" ? (raw.sameSite in SAME_SITE ? SAME_SITE[raw.sameSite] : raw.sameSite) : undefined, expires: raw.expirationDate === undefined ? undefined : new Date(raw.expirationDate * 1000).toISOString() });
    }
    // peek: a sync arrives every minute per site and must not reload the workspace.
    const { cookies: jar } = await workspaces.peek(pair.workspace);
    jar.replaceBrowserSite(site.origin, cookies);
    return { ok: true, count: cookies.length };
  });

  // The extension ends its own pairing (Forget connection, or moving to another Yamlet).
  // The request is encrypted with the pairing's secret, which proves who sends it.
  app.post<{ Body: { pairingId?: string; iv?: string; ciphertext?: string } }>("/api/interceptor/unpair", { bodyLimit: 2048 }, async (req) => {
    if (!extensionRequest(req)) throw new HttpError(403, "Unpairing must come from the extension.");
    const { pair, data } = await openEnvelope(req.body);
    if (data.unpair !== pair.id) throw new HttpError(400, "Invalid unpair request.");
    const revokedAt = new Date().toISOString();
    await update((list) => list.map((item) => (item.id === pair.id ? { ...item, secret: "", revokedAt } : item)));
    return { ok: true };
  });
}
