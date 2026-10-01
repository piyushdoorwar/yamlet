export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 2 : 1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Pretty-print JSON; returns the input unchanged if it isn't JSON. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
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
