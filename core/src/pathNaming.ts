// On-disk names derived from user-entered names. Files and folders carry the display name
// itself (`Get All.request.yaml`), minus characters that some file systems reject.
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * `name` as a file or folder name that works on Windows, macOS and Linux: reserved
 * characters become `-`, whitespace collapses, no leading dot (hidden) or trailing dot/space.
 */
export function fileSafeName(name: string, fallback = "Untitled"): string {
  let out = (name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (out.length > 120) out = out.slice(0, 120).trimEnd();
  if (!out) return fallback;
  return RESERVED.test(out) ? `${out}_` : out;
}

/**
 * A path in `directory` for `<base><suffix>` that does not collide with an existing entry,
 * appending ` 2`, ` 3`, ... to the base as needed. `except` is treated as free (the file
 * being renamed). The suffix may be compound (`.request.yaml`).
 */
export function uniqueFilePath(directory: string, base: string, suffix: string, except?: string): string {
  let candidate = path.join(directory, base + suffix);
  for (let n = 2; existsSync(candidate) && !samePath(candidate, except); n++) {
    candidate = path.join(directory, `${base} ${n}${suffix}`);
  }
  return candidate;
}

export function uniqueDirectoryPath(parent: string, name: string, except?: string): string {
  let candidate = path.join(parent, name);
  for (let n = 2; existsSync(candidate) && !samePath(candidate, except); n++) {
    candidate = path.join(parent, `${name} ${n}`);
  }
  return candidate;
}

/** Same entry, including a case-only rename on a case-insensitive file system. */
function samePath(a: string, b: string | undefined): boolean {
  if (!b) return false;
  if (a === b) return true;
  if (a.toLowerCase() !== b.toLowerCase()) return false;
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}
