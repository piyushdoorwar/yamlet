import type { KeyValue, PathVariable } from "@core/models";

// The URL box and the Params table edit the same data. Values stay raw (not
// percent-decoded) so {{placeholders}} survive the round trip.

export function splitUrl(url: string): { base: string; query: string; hash: string } {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = noHash.indexOf("?");
  return q >= 0 ? { base: noHash.slice(0, q), query: noHash.slice(q + 1), hash } : { base: noHash, query: "", hash };
}

export function parseQuery(query: string): KeyValue[] {
  if (!query) return [];
  return query
    .split("&")
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq >= 0 ? { key: part.slice(0, eq), value: part.slice(eq + 1), enabled: true } : { key: part, value: "", enabled: true };
    });
}

export function buildQuery(params: KeyValue[]): string {
  return params
    .filter((p) => p.enabled && (p.key || p.value))
    .map((p) => (p.value === "" && !p.key.includes("=") ? p.key : `${p.key}=${p.value}`))
    .join("&");
}

// A request stores its URL without the query string; enabled `queryParams` are
// appended when it's sent. The URL box shows both together.

/** What the URL box shows: the stored URL plus the enabled params. */
export function displayUrl(url: string, params: KeyValue[]): string {
  const { base, query, hash } = splitUrl(url);
  const q = [query, buildQuery(params)].filter(Boolean).join("&");
  return `${base}${q ? `?${q}` : ""}${hash}`;
}

/** URL box edited: split the text into the stored URL and params (disabled params are kept). */
export function fromDisplayUrl(text: string, previous: KeyValue[]): { url: string; queryParams: KeyValue[] } {
  const { base, query, hash } = splitUrl(text);
  const described = new Map(previous.map((p) => [p.key, p.description]));
  const enabled = parseQuery(query).map((p) => ({ ...p, description: described.get(p.key) }));
  return { url: base + hash, queryParams: [...enabled, ...previous.filter((p) => !p.enabled)] };
}

const PATH_VAR = /\/:([A-Za-z_][\w.-]*)/g;

/** `:name` segments in the URL path, keeping values the user already typed. */
export function pathVariablesFromUrl(url: string, previous: PathVariable[]): PathVariable[] {
  const { base } = splitUrl(url);
  const afterScheme = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  const names: string[] = [];
  for (const m of afterScheme.matchAll(PATH_VAR)) if (!names.includes(m[1])) names.push(m[1]);
  const old = new Map(previous.map((p) => [p.key, p]));
  return names.map((key) => old.get(key) ?? { key, value: "" });
}
