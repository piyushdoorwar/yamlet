import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { StoredCookie } from "../../../core/src/cookieJar.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";
import { isExtensionRequest } from "../security.js";

interface Pairing { id: string; secret: string; workspace: string; createdAt: string }
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
  let cache: Pairing[] | undefined;
  const pairings = async (): Promise<Pairing[]> => {
    if (cache) return cache;
    try {
      const data: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      cache = Array.isArray(data) ? data.filter((x): x is Pairing => x && typeof x.id === "string" && typeof x.secret === "string" && typeof x.workspace === "string") : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cache = [];
    }
    return cache;
  };
  const save = async (): Promise<void> => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(await pairings()), { mode: 0o600 });
    await fs.rename(temp, file);
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
    return { paired: (await pairings()).some((pair) => pair.workspace === store.workspace.rootPath) };
  });

  app.delete("/api/interceptor/pairings", async (req) => {
    const { store, cookies } = await workspaces.fromHeaders(req.headers);
    cache = (await pairings()).filter((pair) => pair.workspace !== store.workspace.rootPath);
    await save();
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
    (await pairings()).push(pairing);
    await save();
    return { pairingId: pairing.id, secret: pairing.secret };
  });

  app.post<{ Body: { pairingId?: string; iv?: string; ciphertext?: string } }>("/api/interceptor/sync", { bodyLimit: 1024 * 1024 }, async (req) => {
    if (!extensionRequest(req)) throw new HttpError(403, "Sync must come from the extension.");
    const pair = (await pairings()).find((item) => item.id === req.body?.pairingId);
    if (!pair || typeof req.body?.iv !== "string" || typeof req.body?.ciphertext !== "string") throw new HttpError(403, "Invalid pairing.");
    let data: { site?: unknown; cookies?: unknown };
    try {
      const iv = Buffer.from(req.body.iv, "base64url");
      const encrypted = Buffer.from(req.body.ciphertext, "base64url");
      if (iv.length !== 12 || encrypted.length < 17) throw new Error("Invalid encrypted payload");
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(pair.secret, "base64url"), iv);
      decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
      data = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8"));
    } catch {
      throw new HttpError(400, "Could not decrypt cookie snapshot.");
    }
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
}
