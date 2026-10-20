// OAuth 2.0 token acquisition: client-credentials and password grants, the
// authorization-code + PKCE helpers, refresh, and a small in-memory token cache.
import { createHash, randomBytes } from "node:crypto";
import { request, type Dispatcher } from "undici";
import { defaultAgent } from "./agents.js";
import type { OAuth2Config } from "./models.js";

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  /** expiresIn as a time (ms since the epoch), stamped when the token arrived. */
  expiresAt?: number;
  raw: unknown;
}

export interface OAuth2RequestOptions {
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}

type Resolve = (s: string) => string;

/**
 * A token request that failed. `kind` says whose problem it is: `config` (fix the
 * settings), `network` (the token URL could not be reached) or `provider` (the
 * authorization server answered with an error).
 */
export class OAuth2Error extends Error {
  constructor(
    public readonly kind: "config" | "network" | "provider",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OAuth2Error";
  }
}

const UNRESOLVED = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/;

/** Resolves a URL field and checks it can be requested. */
function resolveUrl(label: string, raw: string, resolve: Resolve): string {
  const url = resolve(raw).trim();
  if (!url) throw new OAuth2Error("config", `${label} is not set`);
  const missing = UNRESOLVED.exec(url);
  if (missing) throw new OAuth2Error("config", `${label} uses {{${missing[1]}}}, which is not defined in any active scope`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OAuth2Error("config", `${label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new OAuth2Error("config", `${label} must start with http:// or https://`);
  return url;
}

const NETWORK_HINTS: Record<string, string> = {
  ENOTFOUND: "the host name could not be found",
  EAI_AGAIN: "the host name could not be resolved",
  ECONNREFUSED: "the connection was refused",
  ECONNRESET: "the connection was reset",
  ETIMEDOUT: "the connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
  UND_ERR_HEADERS_TIMEOUT: "the server took too long to answer",
  UND_ERR_BODY_TIMEOUT: "the server took too long to answer",
  CERT_HAS_EXPIRED: "the server's TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the server uses a self-signed TLS certificate",
  SELF_SIGNED_CERT_IN_CHAIN: "the server's TLS certificate chain is self-signed",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server's TLS certificate could not be verified",
};

function networkError(url: string, err: unknown): OAuth2Error {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.code;
  const reason = (code && NETWORK_HINTS[code]) ?? e?.cause?.message ?? e?.message ?? String(err);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw URL
  }
  return new OAuth2Error("network", `Could not reach the token URL (${host}): ${reason}`);
}

/** The provider's own error (RFC 6749 `error` / `error_description`), or a body excerpt. */
function providerError(status: number, text: string): OAuth2Error {
  let detail = "";
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const err = typeof o.error === "string" ? o.error : typeof o.message === "string" ? o.message : "";
    const desc = typeof o.error_description === "string" ? o.error_description : "";
    detail = [err, desc].filter(Boolean).join(": ");
  } catch {
    const form = new URLSearchParams(text);
    if (form.get("error")) detail = [form.get("error"), form.get("error_description")].filter(Boolean).join(": ");
  }
  if (!detail) detail = text.trim().replace(/\s+/g, " ").slice(0, 300) || "empty response";
  const hint = /invalid_client/i.test(detail)
    ? " Check the client ID and secret, and whether the provider expects them in the Basic auth header or the request body."
    : /invalid_grant/i.test(detail)
      ? " The username, password, code or refresh token was rejected."
      : /invalid_scope/i.test(detail)
        ? " Check the scope value."
        : "";
  return new OAuth2Error("provider", `The token endpoint answered ${status}: ${detail}.${hint}`, status);
}

const base64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createPkce(method: "S256" | "plain" = "S256"): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = method === "plain" ? verifier : base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** `audience` and `resource`, when set. */
function extraParams(cfg: OAuth2Config, resolve: Resolve): [string, string][] {
  const out: [string, string][] = [];
  const audience = resolve(cfg.audience ?? "").trim();
  const resource = resolve(cfg.resource ?? "").trim();
  if (audience) out.push(["audience", audience]);
  if (resource) out.push(["resource", resource]);
  return out;
}

export function buildAuthorizationUrl(
  cfg: OAuth2Config,
  resolve: Resolve,
  opts: { state: string; codeChallenge?: string; redirectUri: string },
): string {
  const authUrl = resolveUrl("Auth URL", cfg.authUrl, resolve);
  const params = new URLSearchParams({ response_type: cfg.grantType === "implicit" ? "token" : "code", client_id: resolve(cfg.clientId), redirect_uri: opts.redirectUri });
  const scope = resolve(cfg.scope).trim();
  if (scope) params.set("scope", scope);
  params.set("state", opts.state);
  for (const [k, v] of extraParams(cfg, resolve)) params.set(k, v);
  if (opts.codeChallenge && cfg.grantType !== "implicit") {
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
      throw new OAuth2Error("provider", `The token endpoint did not return JSON: ${text.trim().slice(0, 200) || "empty response"}`);
    }
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const accessToken = typeof o.access_token === "string" ? o.access_token : "";
  if (!accessToken) {
    const err = o.error ? `${o.error}${o.error_description ? `: ${o.error_description}` : ""}` : "the response has no access_token";
    throw new OAuth2Error("provider", `Token request failed: ${err}`);
  }
  const expires = Number(o.expires_in);
  const result: TokenResponse = { accessToken, raw };
  if (typeof o.refresh_token === "string" && o.refresh_token) result.refreshToken = o.refresh_token;
  if (typeof o.token_type === "string" && o.token_type) result.tokenType = o.token_type;
  if (Number.isFinite(expires) && expires > 0) {
    result.expiresIn = expires;
    result.expiresAt = Date.now() + expires * 1000;
  }
  return result;
}

async function requestToken(
  cfg: OAuth2Config,
  resolve: Resolve,
  form: Record<string, string>,
  opts: OAuth2RequestOptions = {},
): Promise<TokenResponse> {
  const url = resolveUrl("Token URL", cfg.accessTokenUrl, resolve);
  const clientId = resolve(cfg.clientId);
  const clientSecret = resolve(cfg.clientSecret);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  const body = new URLSearchParams(form);
  for (const [k, v] of extraParams(cfg, resolve)) body.set(k, v);
  if (cfg.clientAuthentication === "body") {
    if (clientId) body.set("client_id", clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  } else if (clientId || clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
  }
  let res: Dispatcher.ResponseData;
  let text: string;
  try {
    res = await request(url, {
      method: "POST",
      headers,
      body: body.toString(),
      dispatcher: opts.dispatcher ?? defaultAgent(),
      signal: opts.signal,
    });
    text = await res.body.text();
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw networkError(url, err);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) throw providerError(res.statusCode, text);
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
  // Credentials are part of the key: a changed secret or password gets its own token.
  return [cfg.grantType, resolve(cfg.accessTokenUrl), resolve(cfg.clientId), resolve(cfg.clientSecret), resolve(cfg.scope), resolve(cfg.username), resolve(cfg.password), cfg.clientAuthentication, resolve(cfg.audience ?? ""), resolve(cfg.resource ?? "")].join("|");
}

/** Drops the cached token for this config (the server rejected it). */
export function forgetCachedToken(cfg: OAuth2Config, resolve: Resolve): void {
  cache.delete(cacheKey(cfg, resolve));
}

/** True when a token with this expiry should be renewed before use. */
export function isExpired(expiresAt: number | undefined): boolean {
  return !!expiresAt && expiresAt - EXPIRY_MARGIN_MS < Date.now();
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

// Tokens obtained with a stored refresh token, so later sends (and runs) use them
// until the request's saved token catches up.
const refreshed = new Map<string, TokenResponse>();
const refreshKey = (cfg: OAuth2Config, resolve: Resolve, refreshToken: string) => [resolve(cfg.accessTokenUrl), resolve(cfg.clientId), refreshToken].join("|");

/** The newer token got with this config's refresh token, if any. */
export function refreshedTokenFor(cfg: OAuth2Config, resolve: Resolve): TokenResponse | undefined {
  const rt = resolve(cfg.refreshToken).trim();
  return rt ? refreshed.get(refreshKey(cfg, resolve, rt)) : undefined;
}

/** Refreshes with the stored refresh token and remembers the result. */
export async function refreshAndRemember(cfg: OAuth2Config, resolve: Resolve, opts?: OAuth2RequestOptions): Promise<TokenResponse> {
  const rt = resolve(cfg.refreshToken).trim();
  // Sends that fail together share one refresh: a rotated refresh token works only once.
  const key = refreshKey(cfg, resolve, rt);
  const running = refreshing.get(key);
  if (running) return running;
  const p = doRefresh(cfg, resolve, rt, opts).finally(() => refreshing.delete(key));
  refreshing.set(key, p);
  return p;
}

const refreshing = new Map<string, Promise<TokenResponse>>();

async function doRefresh(cfg: OAuth2Config, resolve: Resolve, rt: string, opts?: OAuth2RequestOptions): Promise<TokenResponse> {
  // A rotated refresh token is refreshed from its newest value.
  const latest = refreshed.get(refreshKey(cfg, resolve, rt));
  const token = await refreshAccessToken(latest?.refreshToken ? { ...cfg, refreshToken: latest.refreshToken } : cfg, resolve, opts);
  refreshed.set(refreshKey(cfg, resolve, rt), token);
  return token;
}

export function clearTokenCache(): void {
  cache.clear();
  refreshed.clear();
}
