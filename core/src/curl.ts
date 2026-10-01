// Parses a pasted cURL command into a request. Isomorphic.
import { defaultAuth, newRequest, type BodyField, type KeyValue, type YamletRequest } from "./models.js";

/** Shell-style tokenizer: single/double quotes, $'...' ANSI quoting, backslash escapes and line continuations. */
export function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  const s = input.replace(/\^\r?\n/g, " "); // Windows cmd continuation
  const push = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next === "\r" && s[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (next !== undefined) {
        cur += next;
        has = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      i++;
      continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      cur += end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      has = true;
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (ch === "$" && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const e = s[i + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0" };
          if (e === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
            cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          if (e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
            cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          cur += map[e] ?? e;
          i += 2;
          continue;
        }
        cur += s[i++];
      }
      has = true;
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) {
          if (s[i + 1] !== "\n") cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += s[i++];
      }
      has = true;
      i++;
      continue;
    }
    cur += ch;
    has = true;
    i++;
  }
  push();
  return tokens;
}

const NO_VALUE_FLAGS = new Set([
  "--compressed", "-s", "--silent", "-S", "--show-error", "-v", "--verbose", "--no-buffer", "-N", "-i", "--include",
  "-f", "--fail", "-g", "--globoff", "--http1.1", "--http2", "--http2-prior-knowledge", "-#", "--progress-bar", "-O", "--remote-name",
]);
const VALUE_FLAGS_IGNORED = new Set([
  "-o", "--output", "-w", "--write-out", "--retry", "-x", "--proxy", "--cacert", "--cert", "-E", "--key", "--resolve",
  "--connect-timeout", "-c", "--cookie-jar", "-r", "--range", "--limit-rate", "-y", "--speed-time", "-Y", "--speed-limit", "-A", "--user-agent",
]);

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function splitQuery(url: string): { base: string; params: KeyValue[] } {
  const hashAt = url.indexOf("#");
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = noHash.indexOf("?");
  if (qAt < 0) return { base: url, params: [] };
  const params = noHash
    .slice(qAt + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return {
        key: decode(eq >= 0 ? pair.slice(0, eq) : pair),
        value: eq >= 0 ? decode(pair.slice(eq + 1)) : "",
        enabled: true,
      };
    });
  return { base: noHash.slice(0, qAt), params };
}

const FORM_PAIRS = /^[^=&\s{}[\]"]+=[^&]*(&[^=&\s{}[\]"]+=[^&]*)*$/;

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function requestName(method: string, url: string): string {
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
  return `${method} ${path || "/"}`;
}

/** Parses a cURL command; throws if the text is not a cURL command with a URL. */
export function parseCurl(text: string): YamletRequest {
  const parsed = tryParseCurl(text);
  if (!parsed) throw new Error("Not a valid cURL command");
  return parsed;
}

export function tryParseCurl(text: string): YamletRequest | undefined {
  if (!text?.trim()) return undefined;
  const tokens = tokenizeShell(text.trim());
  const start = tokens.findIndex((t) => /^curl(\.exe)?$/i.test(t));
  if (start < 0) return undefined;

  let method = "";
  let url = "";
  const headers: KeyValue[] = [];
  const data: string[] = [];
  const urlencoded: BodyField[] = [];
  const form: BodyField[] = [];
  let binaryFile = "";
  let user: string | undefined;
  let cookie = "";
  let insecure = false;
  let getMode = false;
  let head = false;
  let timeoutMs = 0;

  for (let i = start + 1; i < tokens.length; i++) {
    let tok = tokens[i];
    let inline: string | undefined;
    if (tok.startsWith("--") && tok.includes("=")) {
      inline = tok.slice(tok.indexOf("=") + 1);
      tok = tok.slice(0, tok.indexOf("="));
    } else if (/^-[XHdFubeTm]./.test(tok)) {
      inline = tok.slice(2);
      tok = tok.slice(0, 2);
    }
    const value = (): string => inline ?? tokens[++i] ?? "";

    switch (tok) {
      case "-X":
      case "--request":
        method = value().toUpperCase();
        break;
      case "--url":
        url = value();
        break;
      case "-H":
      case "--header": {
        const raw = value();
        const colon = raw.indexOf(":");
        if (colon > 0) headers.push({ key: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim(), enabled: true });
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-ascii":
      case "--data-binary": {
        const v = value();
        if (tok === "--data-binary" && v.startsWith("@")) binaryFile = v.slice(1);
        else data.push(v);
        break;
      }
      case "--data-urlencode": {
        const v = value();
        const eq = v.indexOf("=");
        if (eq > 0) urlencoded.push({ key: v.slice(0, eq), value: v.slice(eq + 1), enabled: true });
        else urlencoded.push({ key: eq === 0 ? v.slice(1) : v, value: "", enabled: true });
        break;
      }
      case "--json":
        data.push(value());
        if (!headers.some((h) => h.key.toLowerCase() === "content-type"))
          headers.push({ key: "Content-Type", value: "application/json", enabled: true });
        break;
      case "-F":
      case "--form":
      case "--form-string": {
        const pair = value();
        const eq = pair.indexOf("=");
        if (eq > 0) {
          let v = pair.slice(eq + 1);
          const isFile = tok !== "--form-string" && v.startsWith("@");
          if (isFile) v = v.slice(1).replace(/;type=[^;]*$/, "");
          else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
          form.push({ key: pair.slice(0, eq), value: v, enabled: true, isFile });
        }
        break;
      }
      case "-u":
      case "--user":
        user = value();
        break;
      case "-b":
      case "--cookie":
        cookie = cookie ? `${cookie}; ${value()}` : value();
        break;
      case "-e":
      case "--referer":
        headers.push({ key: "Referer", value: value(), enabled: true });
        break;
      case "-T":
      case "--upload-file":
        binaryFile = value();
        if (!method) method = "PUT";
        break;
      case "-m":
      case "--max-time": {
        const secs = parseFloat(value());
        if (secs > 0) timeoutMs = Math.round(secs * 1000);
        break;
      }
      case "-k":
      case "--insecure":
        insecure = true;
        break;
      case "-L":
      case "--location":
        break;
      case "-G":
      case "--get":
        getMode = true;
        break;
      case "-I":
      case "--head":
        head = true;
        break;
      default:
        if (VALUE_FLAGS_IGNORED.has(tok)) {
          if (inline === undefined) i++;
        } else if (NO_VALUE_FLAGS.has(tok) || tok.startsWith("-")) {
          // ignored flag
        } else if (!url) url = tok;
    }
  }

  if (!url) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("{{")) url = `http://${url}`;

  const req = newRequest();
  const contentType = headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  const joined = data.join("&");

  if (getMode && (data.length || urlencoded.length)) {
    const extra = [joined, ...urlencoded.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`)]
      .filter(Boolean)
      .join("&");
    url += (url.includes("?") ? "&" : "?") + extra;
  } else if (form.length) {
    req.body.type = "form-data";
    req.body.fields = form;
  } else if (binaryFile) {
    req.body.type = "binary";
    req.body.binaryFile = binaryFile;
  } else if (urlencoded.length || data.length) {
    const formLike = contentType.includes("x-www-form-urlencoded") || (!contentType && FORM_PAIRS.test(joined));
    if (urlencoded.length || (formLike && !looksLikeJson(joined))) {
      req.body.type = "urlencoded";
      const fromData = joined
        ? joined.split("&").filter(Boolean).map((pair) => {
            const eq = pair.indexOf("=");
            return { key: decode(eq >= 0 ? pair.slice(0, eq) : pair), value: eq >= 0 ? decode(pair.slice(eq + 1)) : "", enabled: true };
          })
        : [];
      req.body.fields = [...fromData, ...urlencoded];
    } else {
      req.body.raw = joined;
      req.body.type = contentType.includes("json") || (!contentType && looksLikeJson(joined))
        ? "json"
        : contentType.includes("xml")
          ? "xml"
          : contentType.includes("html")
            ? "html"
            : contentType.startsWith("text/")
              ? "text"
              : "raw";
    }
  }

  if (!method) {
    method = head ? "HEAD" : !getMode && req.body.type !== "none" ? "POST" : "GET";
  }

  const { base, params } = splitQuery(url);
  req.url = base;
  req.queryParams = params;
  req.method = method;
  req.name = requestName(method, base);
  req.settings.skipSslVerification = insecure;
  if (timeoutMs) req.settings.timeoutMs = timeoutMs;

  // Promote auth-related input to the auth model.
  const authIdx = headers.findIndex((h) => h.key.toLowerCase() === "authorization" && /^bearer\s+/i.test(h.value));
  if (user !== undefined) {
    const colon = user.indexOf(":");
    req.auth = { ...defaultAuth("basic"), username: colon >= 0 ? user.slice(0, colon) : user, password: colon >= 0 ? user.slice(colon + 1) : "" };
  } else if (authIdx >= 0) {
    req.auth = { ...defaultAuth("bearer"), token: headers[authIdx].value.replace(/^bearer\s+/i, "").trim() };
    headers.splice(authIdx, 1);
  }
  if (cookie) {
    if (req.auth.type === "inherit") req.auth = { ...defaultAuth("cookie"), cookie };
    else headers.push({ key: "Cookie", value: cookie, enabled: true });
  }
  req.headers = headers.filter((h) => h.key.toLowerCase() !== "user-agent");
  return req;
}
