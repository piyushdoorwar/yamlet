// Git-friendly on-disk names derived from user-entered names.
import { existsSync } from "node:fs";
import path from "node:path";

/** Lowercase, hyphen-separated, ASCII-safe slug; `fallback` when nothing usable remains. */
export function slugify(name: string, fallback = "untitled"): string {
  if (!name?.trim()) return fallback;
  let out = "";
  let lastHyphen = false;
  for (const ch of name.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      lastHyphen = false;
    } else if (" -_./".includes(ch)) {
      if (!lastHyphen && out.length > 0) {
        out += "-";
        lastHyphen = true;
      }
    }
  }
  out = out.replace(/^-+|-+$/g, "");
  return out || fallback;
}

/**
 * A path in `directory` for `fileName` that does not collide with an existing entry,
 * appending `-2`, `-3`, ... as needed. `except` is treated as free (the file being renamed).
 */
export function uniqueFilePath(directory: string, fileName: string, except?: string): string {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(directory, fileName);
  for (let n = 2; existsSync(candidate) && candidate !== except; n++) {
    candidate = path.join(directory, `${base}-${n}${ext}`);
  }
  return candidate;
}

export function uniqueDirectoryPath(parent: string, name: string, except?: string): string {
  let candidate = path.join(parent, name);
  for (let n = 2; existsSync(candidate) && candidate !== except; n++) {
    candidate = path.join(parent, `${name}-${n}`);
  }
  return candidate;
}
