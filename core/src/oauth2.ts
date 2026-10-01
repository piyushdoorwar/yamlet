// OAuth 2.0 token acquisition: client-credentials and password grants, the
// authorization-code + PKCE helpers, refresh, and a small in-memory token cache.
import { createHash, randomBytes } from "node:crypto";
import { request, type Dispatcher } from "undici";
import type { OAuth2Config } from "./models.js";

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  raw: unknown;
}

export interface OAuth2RequestOptions {
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}

type Resolve = (s: string) => string;

const base64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createPkce(method: "S256" | "plain" = "S256"): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = method === "plain" ? verifier : base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizationUrl(
  cfg: OAuth2Config,
  resolve: Resolve,
  opts: { state: string; codeChallenge?: string; redirectUri: string },
): string {
  const authUrl = resolve(cfg.authUrl).trim();
  if (!authUrl) throw new Error("OAuth 2.0 authorization URL is not set");
  const params = new URLSearchParams({ response_type: "code", client_id: resolve(cfg.clientId), redirect_uri: opts.redirectUri });
  const scope = resolve(cfg.scope).trim();
  if (scope) params.set("scope", scope);
  params.set("state", opts.state);
  if (opts.codeChallenge) {
    params.set("code_challenge", opts.codeChallenge);
    params.set("code_challenge_method", cfg.challengeAlgorithm === "plain" ? "plain" : "S256");
  }
  return authUrl + (authUrl.includes("?") ? "&" : "?") + params.toString();
}

function parseTokenBody(text: string, contentType: string): TokenResponse {
  let raw: unknown;
  if (contentType.includes("x-www-form-urlencoded") || (!text.trim().startsWith("{") && text.includes("access_token="))) {
    raw = Object.fromEntries(new URLSearchParams(text));
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Token endpoint returned a non-JSON response: ${text.slice(0, 200)}`);
    }
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const accessToken = typeof o.access_token === "string" ? o.access_token : "";
  if (!accessToken) {
    const err = o.error ? `${o.error}${o.error_description ? `: ${o.error_description}` : ""}` : "no access_token in response";
    throw new Error(`Token request failed: ${err}`);
  }
  const expires = Number(o.expires_in);
  const result: TokenResponse = { accessToken, raw };
  if (typeof o.refresh_token === "string" && o.refresh_token) result.refreshToken = o.refresh_token;
  if (typeof o.token_type === "string" && o.token_type) result.tokenType = o.token_type;
  if (Number.isFinite(expires) && expires > 0) result.expiresIn = expires;
  return result;
}

async function requestToken(
  cfg: OAuth2Config,
  resolve: Resolve,
  form: Record<string, string>,
  opts: OAuth2RequestOptions = {},
): Promise<TokenResponse> {
  const url = resolve(cfg.accessTokenUrl).trim();
  if (!url) throw new Error("OAuth 2.0 access token URL is not set");
  const clientId = resolve(cfg.clientId);
  const clientSecret = resolve(cfg.clientSecret);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  const body = new URLSearchParams(form);
  if (cfg.clientAuthentication === "body") {
    if (clientId) body.set("client_id", clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  } else if (clientId || clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
  }
  const res = await request(url, {
    method: "POST",
    headers,
    body: body.toString(),
    dispatcher: opts.dispatcher,
    signal: opts.signal,
  });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Token request failed (${res.statusCode}): ${text.slice(0, 500)}`);
  }
  const ct = res.headers["content-type"];
  return parseTokenBody(text, String(Array.isArray(ct) ? ct[0] : ct ?? ""));
}

/** Fetches a token for the client-credentials or password grant. */
export async function fetchToken(cfg: OAuth2Config, resolve: Resolve, opts?: OAuth2RequestOptions): Promise<TokenResponse> {
  const form: Record<string, string> = {};
  if (cfg.grantType === "password") {
    form.grant_type = "password";
    form.username = resolve(cfg.username);
    form.password = resolve(cfg.password);
  } else if (cfg.grantType === "client_credentials") {
    form.grant_type = "client_credentials";
  } else {
    throw new Error("The authorization-code grant needs the browser flow; use buildAuthorizationUrl + exchangeAuthorizationCode");
  }
  const scope = resolve(cfg.scope).trim();
  if (scope) form.scope = scope;
  return requestToken(cfg, resolve, form, opts);
}

export async function exchangeAuthorizationCode(
  cfg: OAuth2Config,
  resolve: Resolve,
  args: { code: string; verifier?: string; redirectUri: string },
  opts?: OAuth2RequestOptions,
): Promise<TokenResponse> {
  const form: Record<string, string> = { grant_type: "authorization_code", code: args.code, redirect_uri: args.redirectUri };
  if (args.verifier) form.code_verifier = args.verifier;
  return requestToken(cfg, resolve, form, opts);
}

export async function refreshAccessToken(cfg: OAuth2Config, resolve: Resolve, opts?: OAuth2RequestOptions): Promise<TokenResponse> {
  const refreshToken = resolve(cfg.refreshToken).trim();
  if (!refreshToken) throw new Error("No refresh token available");
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
  const scope = resolve(cfg.scope).trim();
  if (scope) form.scope = scope;
  const result = await requestToken(cfg, resolve, form, opts);
  if (!result.refreshToken) result.refreshToken = refreshToken;
  return result;
}

// ---- Cache --------------------------------------------------------------------

const cache = new Map<string, { token: TokenResponse; expiresAt: number }>();
const EXPIRY_MARGIN_MS = 30_000;
const DEFAULT_LIFETIME_S = 3600;

function cacheKey(cfg: OAuth2Config, resolve: Resolve): string {
  return [cfg.grantType, resolve(cfg.accessTokenUrl), resolve(cfg.clientId), resolve(cfg.scope), resolve(cfg.username), cfg.clientAuthentication].join("|");
}

/** True when the grant can be fetched without user interaction. */
export function canFetchAutomatically(cfg: OAuth2Config, resolve: Resolve): boolean {
  if (cfg.grantType !== "client_credentials" && cfg.grantType !== "password") return false;
  if (!resolve(cfg.accessTokenUrl).trim() || !resolve(cfg.clientId).trim()) return false;
  return cfg.grantType !== "password" || !!resolve(cfg.username).trim();
}

/** A cached token for the client-credentials / password grants, fetched when missing or near expiry. */
export async function getCachedToken(cfg: OAuth2Config, resolve: Resolve, opts?: OAuth2RequestOptions): Promise<TokenResponse> {
  const key = cacheKey(cfg, resolve);
  const hit = cache.get(key);
  if (hit && hit.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return hit.token;
  const token = await fetchToken(cfg, resolve, opts);
  cache.set(key, { token, expiresAt: Date.now() + (token.expiresIn ?? DEFAULT_LIFETIME_S) * 1000 });
  return token;
}

export function clearTokenCache(): void {
  cache.clear();
}
