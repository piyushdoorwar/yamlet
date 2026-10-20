// XML to plain objects for scripts (`xml2Json(text)`), in the familiar shape: the root
// element is the only key, attributes sit under `$`, text under `_` (or the element is
// just its text when it has nothing else), and a repeated child becomes an array.
// Text is trimmed and whitespace between elements is dropped. Isomorphic.

type Node = { name: string; attrs: Record<string, string>; text: string; children: [string, unknown][] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export interface XmlToJsonOptions {
  /** Every child as an array, even a single one (the xml2js default). */
  explicitArray?: boolean;
}

/** An own property even for names like __proto__ or constructor. */
function put(o: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

function shape(n: Node, opts: XmlToJsonOptions): unknown {
  const text = n.text.trim();
  const hasAttrs = Object.keys(n.attrs).length > 0;
  if (!n.children.length && !hasAttrs) return text;
  const out: Record<string, unknown> = {};
  if (hasAttrs) out.$ = n.attrs;
  for (const [name, value] of n.children) {
    const has = Object.hasOwn(out, name);
    if (opts.explicitArray) {
      if (has) (out[name] as unknown[]).push(value);
      else put(out, name, [value]);
    } else if (!has) put(out, name, value);
    else if (Array.isArray(out[name])) (out[name] as unknown[]).push(value);
    else put(out, name, [out[name], value]);
  }
  if (text) out._ = text;
  return out;
}

export function xmlToJson(xml: string, opts: XmlToJsonOptions = {}): Record<string, unknown> {
  const src = String(xml ?? "");
  const stack: Node[] = [];
  let root: Record<string, unknown> | undefined;
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`Invalid XML: ${why} (at character ${i})`);
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const text = src.slice(i, lt < 0 ? src.length : lt);
    if (text.trim()) {
      if (!stack.length) fail("text outside the root element");
      stack[stack.length - 1].text += decode(text);
    }
    if (lt < 0) break;
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) fail("unclosed comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) fail("unclosed CDATA section");
      if (!stack.length) fail("CDATA outside the root element");
      stack[stack.length - 1].text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) fail("unclosed processing instruction");
      i = end + 2;
    } else if (src.startsWith("<!", i)) {
      // DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0;
      let j = i + 2;
      for (; j < src.length; j++) {
        if (src[j] === "[") depth++;
        else if (src[j] === "]") depth--;
        else if (src[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[i + 1] === "/") {
      const end = src.indexOf(">", i);
      if (end < 0) fail("unclosed end tag");
      const name = src.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`</${name}> doesn't match <${open?.name ?? "nothing"}>`);
      i = end + 1;
      const value = shape(open!, opts);
      if (stack.length) stack[stack.length - 1].children.push([name, value]);
      else put((root = {}), name, value);
    } else {
      const m = /^<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(src.slice(i));
      if (!m) fail("malformed start tag");
      if (root && !stack.length) fail("more than one root element");
      const attrs: Record<string, string> = {};
      for (const a of m![2].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) put(attrs, a[1], decode(a[2] ?? a[3] ?? ""));
      const node: Node = { name: m![1], attrs, text: "", children: [] };
      i += m![0].length;
      if (m![3]) {
        const value = shape(node, opts);
        if (stack.length) stack[stack.length - 1].children.push([node.name, value]);
        else put((root = {}), node.name, value);
      } else stack.push(node);
    }
  }
  if (stack.length) fail(`<${stack[stack.length - 1].name}> is never closed`);
  if (!root) fail("no root element");
  return root!;
}

/** `require("xml2js")` in scripts: parseString / parseStringPromise / Parser, on the parser above. */
export function xml2jsShim() {
  type Cb = (err: Error | null, result?: unknown) => void;
  const parse = (xml: unknown, opts: XmlToJsonOptions) => xmlToJson(String(xml ?? ""), { explicitArray: opts.explicitArray !== false });
  const parseString = (xml: unknown, a?: XmlToJsonOptions | Cb, b?: Cb) => {
    const [opts, cb] = typeof a === "function" ? [{}, a] : [a ?? {}, b];
    let result: unknown;
    try {
      result = parse(xml, opts);
    } catch (e) {
      cb?.(e as Error);
      return;
    }
    cb?.(null, result);
  };
  const parseStringPromise = async (xml: unknown, opts: XmlToJsonOptions = {}) => parse(xml, opts);
  class Parser {
    constructor(private readonly opts: XmlToJsonOptions = {}) {}
    parseString(xml: unknown, cb: Cb) {
      parseString(xml, this.opts, cb);
    }
    parseStringPromise(xml: unknown) {
      return parseStringPromise(xml, this.opts);
    }
  }
  return { parseString, parseStringPromise, Parser };
}
