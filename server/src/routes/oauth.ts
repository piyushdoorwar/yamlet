import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { OAuth2Config } from "../../../core/src/models.js";
import { buildAuthorizationUrl, createPkce, exchangeAuthorizationCode, fetchToken, OAuth2Error } from "../../../core/src/oauth2.js";
import { resolveVariables, type VariableContext } from "../../../core/src/variableResolver.js";
import type { WorkspaceStore } from "../../../core/src/workspaceStore.js";
import type { AuthorizeResult, AuthorizeStatus, TokenBody, TokenResult } from "../../../shared/api.js";
import type { Deps } from "../app.js";
import { HttpError } from "../errors.js";

interface PendingAuth {
  config: OAuth2Config;
  ctx: VariableContext;
  verifier: string;
  redirectUri: string;
  status: AuthorizeStatus;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

/** Settings problems are the caller's (400); unreachable or failing providers are upstream (502). */
async function asHttp<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OAuth2Error) throw new HttpError(err.kind === "config" ? 400 : 502, err.message);
    throw err;
  }
}

function contextFor(store: WorkspaceStore, body: TokenBody): VariableContext {
  const collection = body.collectionId ? store.findCollection(body.collectionId) : undefined;
  const env = body.environmentId ? store.findEnvironment(body.environmentId) : undefined;
  return {
    request: body.requestVariables,
    collection: collection?.variables,
    environment: env?.variables,
    globals: store.workspace.globals,
  };
}

function toResult(t: { accessToken: string; refreshToken?: string; tokenType?: string; expiresIn?: number }): TokenResult {
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, tokenType: t.tokenType, expiresIn: t.expiresIn };
}

const page = (title: string, message: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#fcfcfc;color:#24302a;display:grid;place-items:center;height:100vh;margin:0}
main{background:#fff;border:1px solid #dde5e0;border-radius:8px;padding:32px 40px;text-align:center}h1{font-size:18px;color:#0e7a43;margin:0 0 8px}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function oauthRoutes(app: FastifyInstance, { workspaces, config }: Deps): void {
  const pending = new Map<string, PendingAuth>();
  const callbackUrl = `${config.publicUrl}/api/oauth2/callback`;

  const prune = () => {
    const now = Date.now();
    for (const [state, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(state);
  };

  // Client-credentials and password grants: fetched directly by the server.
  app.post<{ Body: TokenBody }>("/api/oauth2/token", async (req): Promise<TokenResult> => {
    const { store } = await workspaces.fromHeaders(req.headers);
    if (!req.body?.config) throw new HttpError(400, "Missing OAuth 2.0 settings");
    const ctx = contextFor(store, req.body);
    const token = await asHttp(() => fetchToken(req.body.config, (s) => resolveVariables(s, ctx), { dispatcher: config.dispatcher }));
    return toResult(token);
  });

  // Authorization code + PKCE: the browser opens authUrl in a popup, the provider
  // redirects back to /api/oauth2/callback, and the UI polls for the outcome.
  app.post<{ Body: TokenBody }>("/api/oauth2/authorize", async (req): Promise<AuthorizeResult> => {
    const { store } = await workspaces.fromHeaders(req.headers);
    if (!req.body?.config) throw new HttpError(400, "Missing OAuth 2.0 settings");
    prune();
    const ctx = contextFor(store, req.body);
    const cfg = req.body.config;
    const state = randomBytes(16).toString("hex");
    const { verifier, challenge } = createPkce(cfg.challengeAlgorithm);
    const redirectUri = resolveVariables(cfg.redirectUri, ctx).trim() || callbackUrl;
    const authUrl = await asHttp(() => buildAuthorizationUrl(cfg, (s) => resolveVariables(s, ctx), { state, codeChallenge: challenge, redirectUri }));
    pending.set(state, { config: cfg, ctx, verifier, redirectUri, status: { status: "pending" }, createdAt: Date.now() });
    return { authUrl, state };
  });

  app.get<{ Querystring: { state?: string } }>("/api/oauth2/authorize/status", async (req): Promise<AuthorizeStatus> => {
    const p = req.query.state ? pending.get(req.query.state) : undefined;
    if (!p) return { status: "error", error: "Unknown or expired authorization attempt" };
    if (p.status.status !== "pending") pending.delete(req.query.state!);
    return p.status;
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string; error_description?: string } }>(
    "/api/oauth2/callback",
    async (req, reply) => {
      reply.type("text/html");
      const p = req.query.state ? pending.get(req.query.state) : undefined;
      if (!p) return page("Authorization expired", "Start again from Yamlet.");
      if (req.query.error) {
        const error = `The provider refused the sign-in: ${[req.query.error, req.query.error_description].filter(Boolean).join(": ")}`;
        p.status = { status: "error", error };
        return page("Authorization failed", escapeHtml(error));
      }
      if (!req.query.code) {
        p.status = { status: "error", error: "The provider redirected back without an authorization code" };
        return page("Authorization failed", "No authorization code was returned.");
      }
      try {
        const token = await exchangeAuthorizationCode(p.config, (s) => resolveVariables(s, p.ctx), {
          code: req.query.code,
          verifier: p.verifier,
          redirectUri: p.redirectUri,
        }, { dispatcher: config.dispatcher });
        p.status = { status: "done", token: toResult(token) };
        return page("Signed in", "Yamlet has the access token. You can close this window.");
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        p.status = { status: "error", error };
        return page("Token exchange failed", escapeHtml(error));
      }
    },
  );
}
