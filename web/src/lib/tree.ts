import type { YamletCollection, YamletFolder, YamletRequest, YamletWorkspace } from "@core/models";

export interface RequestLocation {
  request: YamletRequest;
  collection: YamletCollection;
  /** Ancestor folders, outermost first. */
  folders: YamletFolder[];
}

export interface FolderLocation {
  folder: YamletFolder;
  collection: YamletCollection;
  folders: YamletFolder[];
}

export function findRequest(ws: YamletWorkspace | null, id: string): RequestLocation | undefined {
  if (!ws) return undefined;
  const walk = (c: YamletCollection, f: { folders: YamletFolder[]; requests: YamletRequest[] }, chain: YamletFolder[]): RequestLocation | undefined => {
    const hit = f.requests.find((r) => r.id === id);
    if (hit) return { request: hit, collection: c, folders: chain };
    for (const sub of f.folders) {
      const found = walk(c, sub, [...chain, sub]);
      if (found) return found;
    }
    return undefined;
  };
  for (const c of ws.collections) {
    const found = walk(c, c, []);
    if (found) return found;
  }
  return undefined;
}

export function findFolder(ws: YamletWorkspace | null, id: string): FolderLocation | undefined {
  if (!ws) return undefined;
  const walk = (c: YamletCollection, folders: YamletFolder[], chain: YamletFolder[]): FolderLocation | undefined => {
    for (const f of folders) {
      if (f.id === id) return { folder: f, collection: c, folders: chain };
      const found = walk(c, f.folders, [...chain, f]);
      if (found) return found;
    }
    return undefined;
  };
  for (const c of ws.collections) {
    const found = walk(c, c.folders, []);
    if (found) return found;
  }
  return undefined;
}

/** Every request in tree order (folders before requests, depth-first). */
export function allRequests(container: { folders: YamletFolder[]; requests: YamletRequest[] }, chain: string[] = []): { request: YamletRequest; path: string[] }[] {
  const out: { request: YamletRequest; path: string[] }[] = [];
  for (const f of container.folders) out.push(...allRequests(f, [...chain, f.name]));
  for (const r of container.requests) out.push({ request: r, path: chain });
  return out;
}

export function countRequests(container: { folders: YamletFolder[]; requests: YamletRequest[] }): number {
  return container.requests.length + container.folders.reduce((n, f) => n + countRequests(f), 0);
}
