import type { FastifyInstance } from "fastify";
import type { CookieInfo } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";

export function cookieRoutes(app: FastifyInstance, { workspaces }: Deps): void {
  app.get("/api/cookies", async (req): Promise<CookieInfo[]> => {
    const { cookies } = await workspaces.fromHeaders(req.headers);
    return cookies.list().map((c) => ({
      domain: c.domain,
      path: c.path,
      name: c.name,
      value: c.value,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      fromBrowser: c.browserSite !== undefined,
    }));
  });

  // Adds a cookie, or edits one: `original` names the cookie being replaced.
  app.put<{ Body: { cookie?: CookieInfo; original?: { domain: string; name: string; path?: string } } }>("/api/cookies", async (req) => {
    const { cookies } = await workspaces.fromHeaders(req.headers);
    const c = req.body?.cookie;
    const domain = c?.domain?.trim().replace(/^\./, "").toLowerCase();
    if (!c?.name?.trim() || !domain) throw new HttpError(400, "A cookie needs a name and a domain");
    if (/[;,\s=]/.test(c.name.trim())) throw new HttpError(400, "Cookie names can't contain spaces, '=', ';' or ','");
    if (/[;\r\n]/.test(c.value ?? "")) throw new HttpError(400, "Cookie values can't contain ';' or line breaks");
    let expires: string | undefined;
    if (c.expires) {
      const t = Date.parse(c.expires);
      if (Number.isNaN(t)) throw new HttpError(400, "Expires must be a date, e.g. 2030-01-31T12:00:00Z");
      expires = new Date(t).toISOString();
    }
    const o = req.body.original;
    if (o) cookies.remove(o.domain, o.name, o.path);
    cookies.set({ name: c.name.trim(), value: c.value ?? "", domain, path: c.path?.trim() || "/", secure: !!c.secure, httpOnly: !!c.httpOnly, expires, hostOnly: false });
    return { ok: true };
  });

  app.delete<{ Querystring: { domain?: string; name?: string; path?: string } }>("/api/cookies", async (req) => {
    const { cookies } = await workspaces.fromHeaders(req.headers);
    const { domain, name, path } = req.query;
    if (domain && name) cookies.remove(domain, name, path);
    else cookies.clear(domain);
    return { ok: true };
  });
}
