import type { FastifyInstance } from "fastify";
import type { CookieInfo } from "../../../shared/api.js";
import type { Deps } from "../app.js";

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

  app.delete<{ Querystring: { domain?: string; name?: string; path?: string } }>("/api/cookies", async (req) => {
    const { cookies } = await workspaces.fromHeaders(req.headers);
    const { domain, name, path } = req.query;
    if (domain && name) cookies.remove(domain, name, path);
    else cookies.clear(domain);
    return { ok: true };
  });
}
