// A small JSONPath evaluator for filtering response bodies: $, .name, ['name'], [0], [-1],
// [*], .*, ..name (recursive), [1:3] slices, [a,b] unions and [?(@.x > 1)] filters.

type Json = unknown;

type Selector =
  | { kind: "name"; names: string[] }
  | { kind: "index"; indexes: number[] }
  | { kind: "wildcard" }
  | { kind: "slice"; start?: number; end?: number; step?: number }
  | { kind: "filter"; test: (v: Json) => boolean };

interface Step {
  recursive: boolean;
  selector: Selector;
}

export class JsonPathError extends Error {}

const isObj = (v: Json): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);

function children(v: Json): Json[] {
  return Array.isArray(v) ? v : isObj(v) ? Object.values(v) : [];
}

function descendants(v: Json, out: Json[] = []): Json[] {
  out.push(v);
  for (const c of children(v)) descendants(c, out);
  return out;
}

function select(v: Json, s: Selector): Json[] {
  switch (s.kind) {
    case "name":
      return isObj(v) ? s.names.filter((n) => Object.hasOwn(v, n)).map((n) => v[n]) : Array.isArray(v) && s.names.includes("length") ? [v.length] : [];
    case "index":
      if (!Array.isArray(v)) return [];
      return s.indexes.map((i) => (i < 0 ? v.length + i : i)).filter((i) => i >= 0 && i < v.length).map((i) => v[i]);
    case "wildcard":
      return children(v);
    case "slice": {
      if (!Array.isArray(v)) return [];
      const step = s.step ?? 1;
      if (step === 0) return [];
      const norm = (i: number) => (i < 0 ? Math.max(0, v.length + i) : Math.min(i, v.length));
      const out: Json[] = [];
      if (step > 0) for (let i = norm(s.start ?? 0); i < norm(s.end ?? v.length); i += step) out.push(v[i]);
      else for (let i = s.start === undefined ? v.length - 1 : Math.min(norm(s.start), v.length - 1); i > (s.end === undefined ? -1 : norm(s.end)); i += step) out.push(v[i]);
      return out;
    }
    case "filter":
      return children(v).filter((c) => {
        try {
          return s.test(c);
        } catch {
          return false;
        }
      });
  }
}

// --- Filter expressions: @.a.b op literal, joined by && / ||, or a bare @.a (exists).

function relative(path: string): (v: Json) => Json {
  const steps = parse(`$${path.slice(1)}`);
  return (v) => {
    const r = run(v, steps);
    return r.length ? r[0] : undefined;
  };
}

function literal(text: string): Json {
  const t = text.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  try {
    return JSON.parse(t);
  } catch {
    throw new JsonPathError(`Can't read the value ${t}`);
  }
}

/** Splits on `sep` outside quotes and regex literals. */
function splitOutside(text: string, sep: string): string[] {
  const parts: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
    } else if (ch === "'" || ch === '"' || (ch === "/" && /=~\s*$/.test(text.slice(start, i)))) quote = ch;
    else if (text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function compileFilter(expr: string): (v: Json) => boolean {
  const ors = splitOutside(expr, "||").map((part) =>
    splitOutside(part, "&&").map((cond) => {
      const m = /^\s*(@[^=!<>~]*?)\s*(==|!=|<=|>=|<|>|=~)\s*(.+?)\s*$/.exec(cond);
      if (!m) {
        const exists = cond.trim();
        if (!exists.startsWith("@")) throw new JsonPathError(`Filters compare @ paths, e.g. [?(@.price < 10)]`);
        const get = relative(exists);
        return (v: Json) => get(v) !== undefined;
      }
      const get = relative(m[1].trim());
      const op = m[2];
      if (op === "=~") {
        const re = /^\/(.*)\/([a-z]*)$/.exec(m[3].trim());
        if (!re) throw new JsonPathError("Use =~ with a /regex/");
        const rx = new RegExp(re[1], re[2]);
        return (v: Json) => rx.test(String(get(v)));
      }
      const want = literal(m[3]);
      return (v: Json) => {
        const got = get(v) as never;
        switch (op) {
          case "==":
            return got === want;
          case "!=":
            return got !== want;
          case "<":
            return got < (want as never);
          case "<=":
            return got <= (want as never);
          case ">":
            return got > (want as never);
          default:
            return got >= (want as never);
        }
      };
    }),
  );
  return (v) => ors.some((ands) => ands.every((test) => test(v)));
}

function bracket(inner: string): Selector {
  const t = inner.trim();
  if (t === "*") return { kind: "wildcard" };
  if (t.startsWith("?")) {
    const body = t.slice(1).trim().replace(/^\((.*)\)$/s, "$1");
    return { kind: "filter", test: compileFilter(body) };
  }
  if (/^-?\d*:-?\d*(:-?\d+)?$/.test(t)) {
    const [a, b, c] = t.split(":");
    const n = (x?: string) => (x === undefined || x === "" ? undefined : Number(x));
    return { kind: "slice", start: n(a), end: n(b), step: n(c) };
  }
  const parts = t.split(",").map((p) => p.trim());
  if (parts.every((p) => /^-?\d+$/.test(p))) return { kind: "index", indexes: parts.map(Number) };
  return {
    kind: "name",
    names: parts.map((p) => {
      const m = /^(['"])(.*)\1$/.exec(p);
      if (!m) throw new JsonPathError(`Quote names in brackets, e.g. ['${p}']`);
      return m[2];
    }),
  };
}

/** Finds the `]` that closes the bracket opened at `open`, skipping quotes and nested brackets. */
function closing(path: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < path.length; i++) {
    const ch = path[i];
    if (quote) {
      if (ch === quote && path[i - 1] !== "\\") quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  throw new JsonPathError("A [ is missing its ]");
}

export function parse(path: string): Step[] {
  const p = path.trim();
  if (!p.startsWith("$")) throw new JsonPathError("Start the path with $, e.g. $.data[0].id");
  const steps: Step[] = [];
  let i = 1;
  while (i < p.length) {
    let recursive = false;
    if (p.startsWith("..", i)) {
      recursive = true;
      i += 2;
    } else if (p[i] === ".") i += 1;
    if (p[i] === "[") {
      const end = closing(p, i);
      steps.push({ recursive, selector: bracket(p.slice(i + 1, end)) });
      i = end + 1;
    } else {
      const m = /^(\*|[^.[\]\s]+)/.exec(p.slice(i));
      if (!m) throw new JsonPathError(`Unexpected "${p[i]}" at position ${i + 1}`);
      steps.push({ recursive, selector: m[1] === "*" ? { kind: "wildcard" } : { kind: "name", names: [m[1]] } });
      i += m[1].length;
    }
  }
  return steps;
}

function run(root: Json, steps: Step[]): Json[] {
  let current: Json[] = [root];
  for (const step of steps) {
    const next: Json[] = [];
    for (const v of current) for (const base of step.recursive ? descendants(v) : [v]) next.push(...select(base, step.selector));
    current = next;
  }
  return current;
}

/** Every value `path` selects in `root`. Throws JsonPathError for paths it can't read. */
export function queryJson(root: Json, path: string): Json[] {
  return run(root, parse(path));
}
