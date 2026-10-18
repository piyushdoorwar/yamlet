export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 2 : 1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/**
 * Pretty-print JSON; returns the input unchanged if it isn't JSON. Re-indents the text
 * instead of parsing and printing it, so numbers past 2^53 and escapes stay as sent.
 */
export function prettyJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  // Fast path when printing can't change anything: no long numbers, exponents,
  // trailing zeros, -0 or escapes that JSON.stringify would rewrite.
  if (!/\d{16}|[eE][+-]?\d|\.\d*0(?!\d)|-0(?![.\d])|\\[u/]/.test(text)) return JSON.stringify(parsed, null, 2);
  const out: string[] = [];
  const indents: string[] = [];
  const newline = (depth: number) => (indents[depth] ??= `\n${"  ".repeat(depth)}`);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      let j = i + 1;
      for (;;) {
        j = text.indexOf('"', j);
        let slashes = 0;
        while (text.charCodeAt(j - 1 - slashes) === 92 /* \\ */) slashes++;
        if (slashes % 2 === 0) break;
        j++;
      }
      out.push(text.slice(i, j + 1));
      i = j;
    } else if (c === 123 /* { */ || c === 91 /* [ */) {
      // Empty containers stay on one line.
      let j = i + 1;
      while (j < text.length && text.charCodeAt(j) <= 32) j++;
      if (text.charCodeAt(j) === c + 2) {
        out.push(text[i] + text[j]);
        i = j;
      } else out.push(text[i], newline(++depth));
    } else if (c === 125 /* } */ || c === 93 /* ] */) out.push(newline(--depth), text[i]);
    else if (c === 44 /* , */) out.push(",", newline(depth));
    else if (c === 58 /* : */) out.push(": ");
    else if (c > 32) {
      // A number or literal: copy the whole run.
      let j = i + 1;
      while (j < text.length && text.charCodeAt(j) > 32 && !",:]}".includes(text[j])) j++;
      out.push(text.slice(i, j));
      i = j - 1;
    }
  }
  return out.join("");
}

/** Indent XML/HTML-ish markup, one element per line. */
export function prettyXml(text: string): string {
  const compact = text.replace(/>\s+</g, "><").trim();
  if (!compact.startsWith("<")) return text;
  let depth = 0;
  const out: string[] = [];
  for (const token of compact.split(/(?=<)|(?<=>)/g)) {
    if (!token.trim()) continue;
    if (/^<\//.test(token)) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + token);
    if (/^<[^!?/][^>]*[^/]>$/.test(token) && !/^<(br|hr|img|input|meta|link)\b/i.test(token)) depth++;
  }
  // Collapse <a>text</a> back onto one line.
  return out.join("\n").replace(/(<[^/!?][^>]*>)\n\s*([^<\n]+)\n\s*(<\/)/g, "$1$2$3");
}

export function languageFor(contentType: string): "json" | "xml" | "html" | "javascript" | "text" {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("javascript")) return "javascript";
  return "text";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadBlob(data: BlobPart, fileName: string, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
