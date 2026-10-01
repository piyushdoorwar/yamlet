import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { HttpError } from "./errors.js";

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True when `child` is `parent` or lies beneath it (after resolving symlinks). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(real(parent), real(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve a user-supplied path and refuse anything outside `root`. */
export function confine(root: string, p: string): string {
  const abs = resolve(root, p);
  if (!isInside(root, abs)) throw new HttpError(403, `Path is outside ${root}`);
  return abs;
}
