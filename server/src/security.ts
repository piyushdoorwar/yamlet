import type { FastifyInstance } from "fastify";
import { CSRF_HEADER } from "../../shared/api.js";

// Yamlet has no login: it reads and writes files on disk and sends arbitrary
// HTTP requests on the user's behalf, so it must only answer the user's own
// browser.
//
//   1. Publish the port on 127.0.0.1 (the documented `docker run` does).
//   2. Host must be a loopback name (or one listed in YAMLET_ALLOWED_HOSTS) to
//      defeat DNS rebinding.
//   3. A sent Origin must match Host, so other sites can't drive the API.
//   4. State-changing requests need a custom header, which a cross-site form or
//      simple fetch can't add without a preflight we never grant.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The Yamlet Interceptor extension may call only these two routes. Starting a
// pairing, reading status and revoking stay same-origin (the Yamlet UI).
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const EXTENSION_ROUTES = new Set(["/api/interceptor/pair/finish", "/api/interceptor/sync"]);

export function isExtensionRequest(origin: string | undefined, url: string): boolean {
  return !!origin && EXTENSION_ORIGIN.test(origin) && EXTENSION_ROUTES.has(url.split("?")[0]);
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

export function allowedHostnames(extra = process.env.YAMLET_ALLOWED_HOSTS): Set<string> {
  const names = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const h of (extra ?? "").split(",")) {
    const name = h.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

export function isAllowedHost(host: string | undefined, allowed: Set<string>): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  return name !== null && (allowed.has(name) || name.endsWith(".localhost"));
}

/** No Origin (curl, health checks) is fine; otherwise it must be this server. */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // The HTML response preview renders in a sandboxed srcdoc iframe.
  "frame-src 'self' blob: data:",
  "frame-ancestors 'none'",
].join("; ");

export function registerSecurity(app: FastifyInstance, allowed = allowedHostnames()): void {
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host;
    if (!isAllowedHost(host, allowed)) {
      return reply.code(403).send({ error: "Yamlet only accepts requests addressed to localhost." });
    }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const extensionOrigin = isExtensionRequest(origin, req.url);
    if (extensionOrigin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "content-type, x-yamlet");
      if (req.method === "OPTIONS") return reply.code(204).send();
    }
    if (!extensionOrigin && !isSameOrigin(origin, host)) {
      return reply.code(403).send({ error: "Cross-origin requests are not allowed." });
    }
    // The OAuth redirect is a top-level GET from the provider, so it needs no header.
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== "1") {
      return reply.code(403).send({ error: `Missing ${CSRF_HEADER} header.` });
    }
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  });
}
