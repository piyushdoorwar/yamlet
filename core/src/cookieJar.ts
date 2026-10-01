// A small RFC 6265 style cookie jar. Isomorphic (uses only the URL global).
import type { ResponseCookie } from "./models.js";

export interface StoredCookie {
  name: string;
  value: string;
  /** Lower-case domain without a leading dot. */
  domain: string;
  path: string;
  /** Domain attribute absent: cookie only goes back to the exact host. */
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  /** ISO timestamp; undefined for session cookies. */
  expires?: string;
  createdAt: string;
}

/** Parses one Set-Cookie header value into its parts (no domain defaulting). */
export function parseSetCookie(header: string): ResponseCookie | undefined {
  const parts = header.split(";");
  const first = parts.shift() ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return undefined;
  const cookie: ResponseCookie = { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
  if (!cookie.name) return undefined;
  if (cookie.value.length >= 2 && cookie.value.startsWith('"') && cookie.value.endsWith('"')) cookie.value = cookie.value.slice(1, -1);
  let maxAge: number | undefined;
  for (const raw of parts) {
    const i = raw.indexOf("=");
    const key = (i >= 0 ? raw.slice(0, i) : raw).trim().toLowerCase();
    const val = i >= 0 ? raw.slice(i + 1).trim() : "";
    switch (key) {
      case "domain":
        if (val) cookie.domain = val.replace(/^\./, "").toLowerCase();
        break;
      case "path":
        if (val.startsWith("/")) cookie.path = val;
        break;
      case "expires": {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) cookie.expires = new Date(t).toISOString();
        break;
      }
      case "max-age": {
        const n = parseInt(val, 10);
        if (!Number.isNaN(n)) maxAge = n;
        break;
      }
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite":
        cookie.sameSite = val;
        break;
    }
  }
  if (maxAge !== undefined) cookie.expires = new Date(Date.now() + maxAge * 1000).toISOString();
  return cookie;
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const last = pathname.lastIndexOf("/");
  return last <= 0 ? "/" : pathname.slice(0, last);
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || (host.endsWith("." + domain) && !/^\d+\.\d+\.\d+\.\d+$/.test(host));
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export class CookieJar {
  private cookies: StoredCookie[] = [];

  /** Stores cookies from a response's Set-Cookie headers. */
  setFromResponse(url: string, setCookie: string[]): void {
    const u = parseUrl(url);
    if (!u) return;
    const host = u.hostname.toLowerCase();
    for (const header of setCookie) {
      const c = parseSetCookie(header);
      if (!c) continue;
      let domain = host;
      let hostOnly = true;
      if (c.domain) {
        if (!domainMatches(host, c.domain)) continue; // a host may not set cookies for unrelated domains
        domain = c.domain;
        hostOnly = false;
      }
      const stored: StoredCookie = {
        name: c.name,
        value: c.value,
        domain,
        path: c.path ?? defaultPath(u.pathname),
        hostOnly,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite,
        expires: c.expires,
        createdAt: new Date().toISOString(),
      };
      const idx = this.cookies.findIndex((x) => x.name === stored.name && x.domain === stored.domain && x.path === stored.path);
      if (idx >= 0) stored.createdAt = this.cookies[idx].createdAt;
      const expired = stored.expires !== undefined && Date.parse(stored.expires) <= Date.now();
      if (idx >= 0) this.cookies.splice(idx, 1);
      if (!expired) this.cookies.push(stored);
    }
  }

  /** Cookies that apply to a request URL, longest path first. */
  cookiesFor(url: string): StoredCookie[] {
    const u = parseUrl(url);
    if (!u) return [];
    this.purgeExpired();
    const host = u.hostname.toLowerCase();
    const secure = u.protocol === "https:" || u.protocol === "wss:";
    return this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)))
      .filter((c) => pathMatches(u.pathname || "/", c.path))
      .filter((c) => !c.secure || secure || host === "localhost" || host === "127.0.0.1")
      .sort((a, b) => b.path.length - a.path.length || a.createdAt.localeCompare(b.createdAt));
  }

  cookieHeaderFor(url: string): string | undefined {
    const list = this.cookiesFor(url);
    return list.length ? list.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
  }

  list(): StoredCookie[] {
    this.purgeExpired();
    return this.cookies.map((c) => ({ ...c }));
  }

  /** Adds or replaces a cookie directly (e.g. from a cookie manager UI). */
  set(cookie: Omit<StoredCookie, "createdAt" | "hostOnly"> & { hostOnly?: boolean; createdAt?: string }): void {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    this.remove(domain, cookie.name, cookie.path);
    this.cookies.push({ ...cookie, domain, hostOnly: cookie.hostOnly ?? false, createdAt: cookie.createdAt ?? new Date().toISOString() });
  }

  remove(domain: string, name: string, path?: string): void {
    const d = domain.replace(/^\./, "").toLowerCase();
    this.cookies = this.cookies.filter((c) => !(c.domain === d && c.name === name && (path === undefined || c.path === path)));
  }

  clear(domain?: string): void {
    if (domain === undefined) this.cookies = [];
    else {
      const d = domain.replace(/^\./, "").toLowerCase();
      this.cookies = this.cookies.filter((c) => c.domain !== d);
    }
  }

  toJSON(): { cookies: StoredCookie[] } {
    return { cookies: this.list() };
  }

  static fromJSON(json: unknown): CookieJar {
    const jar = new CookieJar();
    const list = Array.isArray(json) ? json : (json as { cookies?: unknown })?.cookies;
    if (Array.isArray(list)) {
      for (const c of list) {
        if (c && typeof c === "object" && typeof c.name === "string" && typeof c.domain === "string") {
          jar.cookies.push({
            name: c.name,
            value: String(c.value ?? ""),
            domain: c.domain.replace(/^\./, "").toLowerCase(),
            path: typeof c.path === "string" ? c.path : "/",
            hostOnly: !!c.hostOnly,
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: c.sameSite,
            expires: c.expires,
            createdAt: c.createdAt ?? new Date().toISOString(),
          });
        }
      }
    }
    jar.purgeExpired();
    return jar;
  }

  private purgeExpired(): void {
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires === undefined || Date.parse(c.expires) > now);
  }
}
