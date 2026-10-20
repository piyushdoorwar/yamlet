// Auth schemes computed at send time from the final request: HTTP Digest (RFC 7616,
// answering the server's challenge) and AWS Signature Version 4.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AwsSigV4Config, KeyValue } from "./models.js";

// ---------------------------------------------------------------------------
// Digest

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
}

/** The Digest challenge in a WWW-Authenticate header, if there is one. */
export function parseDigestChallenge(header: string | undefined): DigestChallenge | undefined {
  if (!header) return undefined;
  const at = header.search(/\bDigest\s+/i);
  if (at < 0) return undefined;
  const params: Record<string, string> = {};
  const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
  const text = header.slice(at).replace(/^Digest\s+/i, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = m[1].toLowerCase();
    // Another scheme's parameters start after "<Scheme> "; stop there.
    if (params[key] !== undefined) break;
    params[key] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3];
  }
  if (!params.nonce) return undefined;
  return { realm: params.realm ?? "", nonce: params.nonce, qop: params.qop, opaque: params.opaque, algorithm: params.algorithm ?? "MD5" };
}

/** The Authorization header answering `challenge` for one request. */
export function digestAuthorization(
  c: DigestChallenge,
  opts: { username: string; password: string; method: string; uri: string; cnonce?: string; nc?: number; body?: string | Buffer },
): string {
  const alg = c.algorithm.toUpperCase();
  const hashName = alg.startsWith("SHA-512-256") ? "sha512-256" : alg.startsWith("SHA-256") ? "sha256" : "md5";
  const H = (s: string) => createHash(hashName).update(s).digest("hex");
  const cnonce = opts.cnonce ?? randomBytes(8).toString("hex");
  const nc = (opts.nc ?? 1).toString(16).padStart(8, "0");
  let ha1 = H(`${opts.username}:${c.realm}:${opts.password}`);
  if (alg.endsWith("-SESS")) ha1 = H(`${ha1}:${c.nonce}:${cnonce}`);
  // "auth" when offered; else "auth-int", which also covers the body's hash.
  const offered = c.qop?.split(",").map((q) => q.trim().toLowerCase()) ?? [];
  const qop = offered.includes("auth") ? "auth" : offered.includes("auth-int") ? "auth-int" : undefined;
  const ha2 = qop === "auth-int" ? H(`${opts.method}:${opts.uri}:${createHash(hashName).update(opts.body ?? "").digest("hex")}`) : H(`${opts.method}:${opts.uri}`);
  const response = qop ? H(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${c.nonce}:${ha2}`);
  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  const parts = [
    `username=${q(opts.username)}`,
    `realm=${q(c.realm)}`,
    `nonce=${q(c.nonce)}`,
    `uri=${q(opts.uri)}`,
    `algorithm=${c.algorithm}`,
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce=${q(cnonce)}`] : []),
    `response=${q(response)}`,
    ...(c.opaque !== undefined ? [`opaque=${q(c.opaque)}`] : []),
  ];
  return `Digest ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4

/** RFC 3986 encoding as AWS wants it: everything but unreserved characters. */
const awsEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** AWS's guess at region and service from an amazonaws.com host, for blank settings. */
export function awsScopeFromHost(host: string): { region?: string; service?: string } {
  const m = /^(?:[^.]+\.)*?([a-z0-9-]+)\.(?:([a-z]{2}(?:-gov)?-[a-z]+-\d)\.)?amazonaws\.com(?:\.cn)?$/i.exec(host);
  return m ? { service: m[1], region: m[2] } : {};
}

/**
 * Headers to add so the request is signed. `body` is what will be sent; pass undefined
 * for streamed bodies (multipart), which are signed as UNSIGNED-PAYLOAD.
 */
export function signAwsV4(opts: {
  method: string;
  url: string;
  headers: KeyValue[];
  body: string | Buffer | undefined;
  streamedBody?: boolean;
  aws: AwsSigV4Config;
  now?: Date;
}): KeyValue[] {
  const url = new URL(opts.url);
  const guessed = awsScopeFromHost(url.hostname);
  const region = opts.aws.region.trim() || guessed.region || "us-east-1";
  const service = opts.aws.service.trim() || guessed.service || "execute-api";
  const amzDate = (opts.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = opts.streamedBody ? "UNSIGNED-PAYLOAD" : sha256(opts.body ?? "");

  const added: KeyValue[] = [{ key: "X-Amz-Date", value: amzDate, enabled: true }];
  if (opts.aws.sessionToken.trim()) added.push({ key: "X-Amz-Security-Token", value: opts.aws.sessionToken.trim(), enabled: true });
  if (service === "s3") added.push({ key: "X-Amz-Content-Sha256", value: payloadHash, enabled: true });

  // Sign host, content-type and every x-amz-* header.
  const signed = new Map<string, string>();
  signed.set("host", url.host);
  for (const h of [...opts.headers, ...added]) {
    const k = h.key.toLowerCase();
    if (k === "content-type" || k.startsWith("x-amz-")) {
      const v = h.value.trim().replace(/\s+/g, " ");
      signed.set(k, signed.has(k) ? `${signed.get(k)},${v}` : v);
    }
  }
  const names = [...signed.keys()].sort();
  const canonicalHeaders = names.map((k) => `${k}:${signed.get(k)}\n`).join("");
  const signedHeaders = names.join(";");

  // Each segment is URI-encoded per the SigV4 rules (WHATWG URLs leave + ( ) : = , @ $ ! '
  // as they are): once for S3, twice for other services.
  const path = url.pathname || "/";
  const once = path.split("/").map((seg) => awsEncode(decodeSafe(seg)));
  const canonicalPath = (service === "s3" ? once : once.map((seg) => awsEncode(seg))).join("/");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [opts.method.toUpperCase(), canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${opts.aws.secretKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  added.push({ key: "Authorization", value: `AWS4-HMAC-SHA256 Credential=${opts.aws.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, enabled: true });
  return added;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
