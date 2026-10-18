// Each request's last response, kept in IndexedDB so it is still there after a reload.
// It's a convenience cache: any failure (no IndexedDB, quota, private mode) just means
// nothing is restored.
import type { SseEvent } from "@core/sse";
import type { YamletResponse } from "@core/models";

const DB = "yamlet";
const STORE = "responses";
/** Bodies above this are left out; the head, headers and tests are still kept. */
export const MAX_KEPT_BODY = 5 * 1024 * 1024;
/** Responses kept across all workspaces; the oldest go first. */
const MAX_ENTRIES = 300;

export interface CachedResponse {
  response: YamletResponse;
  events?: SseEvent[];
  savedAt: number;
}

interface Row extends CachedResponse {
  key: string;
}

let opening: Promise<IDBDatabase | undefined> | undefined;

function db(): Promise<IDBDatabase | undefined> {
  opening ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(undefined);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" }).createIndex("savedAt", "savedAt");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      req.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  return opening;
}

const keyOf = (root: string, requestId: string) => `${root}\n${requestId}`;

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** What is kept of a response: everything, minus a body too large to store. */
export function keepable(response: YamletResponse): YamletResponse {
  if (response.body.length <= MAX_KEPT_BODY) return response;
  return { ...response, body: "", bodyEncoding: "utf8", incomplete: "The body was too large to keep after a reload. Send the request again to see it." };
}

export async function saveResponse(root: string, requestId: string, response: YamletResponse, events?: SseEvent[]): Promise<void> {
  try {
    const d = await db();
    if (!d) return;
    const tx = d.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const row: Row = { key: keyOf(root, requestId), response: keepable(response), ...(events?.length ? { events: events.slice(-2000) } : {}), savedAt: Date.now() };
    store.put(row);
    // Trim the oldest once over the limit.
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - MAX_ENTRIES;
      if (extra <= 0) return;
      store.index("savedAt").openCursor().onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor || extra-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
    };
    await done(tx);
  } catch {
    // Not kept; the response is still on screen.
  }
}

export async function loadResponse(root: string, requestId: string): Promise<CachedResponse | undefined> {
  try {
    const d = await db();
    if (!d) return undefined;
    const req = d.transaction(STORE).objectStore(STORE).get(keyOf(root, requestId));
    return await new Promise((resolve) => {
      req.onsuccess = () => {
        const row = req.result as Row | undefined;
        resolve(row ? { response: row.response, events: row.events, savedAt: row.savedAt } : undefined);
      };
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

export async function forgetResponse(root: string, requestId: string): Promise<void> {
  try {
    const d = await db();
    if (!d) return;
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(keyOf(root, requestId));
    await done(tx);
  } catch {
    // Nothing to forget.
  }
}
