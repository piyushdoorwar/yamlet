import type { ServerInfo } from "../../../shared/api";
import type { KeyValue, YamletRequest, YamletResponse, YamletWorkspace } from "@core/models";
import { isEventStream, SseParser, type SseEvent } from "@core/sse";
import { create } from "zustand";
import { api, errorMessage, setApiWorkspace } from "./api";
import { entryFromResponse, useConsole } from "./consoleLog";
import { forgetResponse, loadResponse, saveResponse } from "./responseCache";
import { keys, readJson, writeJson } from "./storage";
import { allRequests, findFolder, findRequest } from "./tree";

export type TabKind = "request" | "collection" | "folder" | "environment" | "globals" | "runner";

export interface Tab {
  kind: TabKind;
  /** Item id (request / collection / folder / environment); "globals" for globals. */
  id: string;
  /** runner: optional folder scope. */
  folderId?: string;
}

export const tabKey = (t: Tab) => `${t.kind}:${t.id}${t.folderId ? `:${t.folderId}` : ""}`;

/** What has arrived of a response that is still being received. */
export interface LiveResponse {
  statusCode: number;
  reasonPhrase: string;
  headers: KeyValue[];
  contentType: string;
  firstByteMs: number;
  /** Body text so far (absent for binary bodies). */
  text?: string;
  bytes: number;
}

export interface ResponseState {
  loading: boolean;
  response?: YamletResponse;
  error?: string;
  startedAt?: number;
  live?: LiveResponse;
  /** Server-sent events in arrival order, for text/event-stream responses. */
  events?: SseEvent[];
  /** Set when the response was restored from an earlier session rather than just sent. */
  restoredAt?: number;
}

export interface HistoryEntry {
  id: string;
  at: number;
  requestId: string;
  name: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  isError: boolean;
  /** The request as sent, so it can be reopened even if edited since; left out when large, so history fits in browser storage. */
  snapshot?: YamletRequest;
}

export type SaveState = "saving" | "saved" | "error";
export type ResponseLayout = "stacked" | "side";

interface Session {
  tabs: Tab[];
  active: string | null;
  environmentId: string | null;
}

interface Prefs {
  layout: ResponseLayout;
  sidebarWidth?: number;
}

interface State {
  info: ServerInfo | null;
  workspace: YamletWorkspace | null;
  loadError: string | null;
  tabs: Tab[];
  active: string | null;
  environmentId: string | null;
  drafts: Record<string, YamletRequest>;
  saveState: Record<string, SaveState>;
  /** Why the last save of a request failed; cleared by the next successful save. */
  saveErrors: Record<string, string>;
  responses: Record<string, ResponseState>;
  history: HistoryEntry[];
  layout: ResponseLayout;

  setInfo: (info: ServerInfo) => void;
  loadWorkspace: (ws: YamletWorkspace) => void;
  closeWorkspace: () => void;
  /** Replace the tree after a server mutation, keeping open editors in sync. */
  applyWorkspace: (ws: YamletWorkspace) => void;

  openTab: (tab: Tab, opts?: { replacePreview?: boolean }) => void;
  closeTab: (key: string) => void;
  closeOtherTabs: (key: string) => void;
  closeTabsToRight: (key: string) => void;
  closeAllTabs: () => void;
  /** Opens the most recently closed tab that still exists. */
  reopenClosedTab: () => void;
  setActive: (key: string) => void;
  moveTab: (from: number, to: number) => void;

  setEnvironment: (id: string | null) => void;
  setLayout: (layout: ResponseLayout) => void;

  updateDraft: (id: string, update: (r: YamletRequest) => YamletRequest) => void;
  /** Writes pending (or previously failed) edits now; saves of one request run in order. */
  saveNow: (id: string) => Promise<void>;

  send: (id: string) => Promise<void>;
  cancel: (id: string) => void;
  /** Shows the request's last response from an earlier session, if one was kept and nothing newer is shown. */
  restoreResponse: (id: string) => Promise<void>;
  clearHistory: () => void;
}

const SAVE_DEBOUNCE_MS = 500;
const HISTORY_LIMIT = 150;
/** A sent request larger than this (a big body) is listed without a copy to restore. */
const MAX_SNAPSHOT_CHARS = 100_000;
/** Snapshots kept per workspace, well inside the browser's ~5 MB storage. */
const HISTORY_BUDGET_CHARS = 1_500_000;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
// The latest queued save per request. While one is queued, server copies of that
// request are older than the draft and must not replace it.
const savesInFlight = new Map<string, Promise<void>>();
// Requests whose last save failed; their drafts are kept until a save succeeds.
const unsaved = new Set<string>();
const inflight = new Map<string, AbortController>();
// Recently closed tabs, newest last, for "reopen closed tab".
const closedTabs: Tab[] = [];
function rememberClosed(tabs: Tab[]) {
  closedTabs.push(...tabs);
  closedTabs.splice(0, Math.max(0, closedTabs.length - 25));
}

function persistSession(s: Pick<State, "workspace" | "tabs" | "active" | "environmentId">) {
  if (!s.workspace) return;
  writeJson(keys.session(s.workspace.rootPath), { tabs: s.tabs, active: s.active, environmentId: s.environmentId } satisfies Session);
}

function tabExists(ws: YamletWorkspace, t: Tab): boolean {
  switch (t.kind) {
    case "request":
      return !!findRequest(ws, t.id);
    case "folder":
      return !!findFolder(ws, t.id);
    case "collection":
      return ws.collections.some((c) => c.id === t.id);
    case "runner":
      return ws.collections.some((c) => c.id === t.id);
    case "environment":
      return ws.environments.some((e) => e.id === t.id);
    case "globals":
      return true;
  }
}

export function rememberRecent(root: string, name: string): void {
  const list = readJson<{ root: string; name: string; at: number }[]>(keys.recent, []);
  const next = [{ root, name, at: Date.now() }, ...list.filter((w) => w.root !== root)].slice(0, 10);
  writeJson(keys.recent, next);
}

export function recentWorkspaces(): { root: string; name: string; at: number }[] {
  return readJson(keys.recent, []);
}

const prefs = readJson<Prefs>(keys.prefs, { layout: "stacked" });

/** The response as far as it got when the user stopped it mid-body. */
function stoppedResponse(request: YamletRequest, live: LiveResponse, elapsedMs: number): YamletResponse {
  const text = live.text ?? "";
  return {
    statusCode: live.statusCode,
    reasonPhrase: live.reasonPhrase,
    durationMs: elapsedMs,
    sizeBytes: live.bytes,
    resolvedUrl: request.url,
    method: request.method,
    requestHeaders: [],
    headers: live.headers,
    cookies: [],
    body: text,
    bodyEncoding: "utf8",
    contentType: live.contentType,
    timings: { total: elapsedMs, firstByte: live.firstByteMs },
    testResults: [],
    scriptLogs: [],
    consoleText: `${request.method} ${request.url}\n\nStopped after ${live.bytes} bytes; post-response scripts did not run.`,
    isError: false,
    incomplete: live.text === undefined ? "Stopped before the binary body was complete." : "Stopped before the response finished; post-response scripts did not run.",
  };
}

export const useStore = create<State>((set, get) => ({
  info: null,
  workspace: null,
  loadError: null,
  tabs: [],
  active: null,
  environmentId: null,
  drafts: {},
  saveState: {},
  saveErrors: {},
  responses: {},
  history: [],
  layout: prefs.layout,

  setInfo: (info) => set({ info }),

  loadWorkspace: (ws) => {
    setApiWorkspace(ws.rootPath);
    rememberRecent(ws.rootPath, ws.name);
    const session = readJson<Session>(keys.session(ws.rootPath), { tabs: [], active: null, environmentId: null });
    const tabs = session.tabs.filter((t) => tabExists(ws, t));
    const active = tabs.some((t) => tabKey(t) === session.active) ? session.active : tabs[0] ? tabKey(tabs[0]) : null;
    const environmentId = ws.environments.some((e) => e.id === session.environmentId)
      ? session.environmentId
      : (ws.environments[0]?.id ?? null);
    set({
      workspace: ws,
      loadError: null,
      tabs,
      active,
      environmentId,
      drafts: {},
      saveState: {},
      saveErrors: {},
      responses: {},
      history: readJson<HistoryEntry[]>(keys.history(ws.rootPath), []),
    });
  },

  closeWorkspace: () => {
    setApiWorkspace(null);
    set({ workspace: null, tabs: [], active: null, drafts: {}, responses: {}, history: [] });
  },

  applyWorkspace: (ws) => {
    const s = get();
    const tabs = s.tabs.filter((t) => tabExists(ws, t));
    const active = tabs.some((t) => tabKey(t) === s.active) ? s.active : tabs[0] ? tabKey(tabs[0]) : null;
    // Drafts follow server-side identity changes (rename, move) but keep unsaved edits.
    const drafts: Record<string, YamletRequest> = {};
    for (const [id, draft] of Object.entries(s.drafts)) {
      const loc = findRequest(ws, id);
      if (!loc) continue;
      const pending = saveTimers.has(id) || savesInFlight.has(id) || unsaved.has(id);
      drafts[id] = pending ? { ...draft, sourceFilePath: loc.request.sourceFilePath } : loc.request;
    }
    const environmentId = ws.environments.some((e) => e.id === s.environmentId) ? s.environmentId : (ws.environments[0]?.id ?? null);
    // A deleted request's last response goes with it, here and in the browser cache.
    let responses = s.responses;
    if (s.workspace?.rootPath === ws.rootPath) {
      const live = new Set(ws.collections.flatMap((c) => allRequests(c).map((r) => r.request.id)));
      for (const c of s.workspace.collections) {
        for (const { request } of allRequests(c)) {
          if (live.has(request.id)) continue;
          void forgetResponse(ws.rootPath, request.id);
          if (responses[request.id]) {
            const { [request.id]: _gone, ...rest } = responses;
            responses = rest;
          }
        }
      }
    }
    set({ workspace: ws, tabs, active, drafts, environmentId, responses });
    persistSession({ ...get() });
  },

  openTab: (tab) => {
    const key = tabKey(tab);
    const s = get();
    const tabs = s.tabs.some((t) => tabKey(t) === key) ? s.tabs : [...s.tabs, tab];
    set({ tabs, active: key });
    persistSession({ ...get() });
  },

  closeTab: (key) => {
    const s = get();
    const idx = s.tabs.findIndex((t) => tabKey(t) === key);
    if (idx < 0) return;
    const closing = s.tabs[idx];
    rememberClosed([closing]);
    if (closing.kind === "request") void get().saveNow(closing.id);
    const tabs = s.tabs.filter((_, i) => i !== idx);
    const active = s.active === key ? (tabs[Math.min(idx, tabs.length - 1)] ? tabKey(tabs[Math.min(idx, tabs.length - 1)]) : null) : s.active;
    set({ tabs, active });
    persistSession({ ...get() });
  },

  closeOtherTabs: (key) => {
    const s = get();
    rememberClosed(s.tabs.filter((t) => tabKey(t) !== key));
    for (const t of s.tabs) if (t.kind === "request" && tabKey(t) !== key) void get().saveNow(t.id);
    set({ tabs: s.tabs.filter((t) => tabKey(t) === key), active: key });
    persistSession({ ...get() });
  },

  closeTabsToRight: (key) => {
    const s = get();
    const idx = s.tabs.findIndex((t) => tabKey(t) === key);
    if (idx < 0) return;
    const closing = s.tabs.slice(idx + 1);
    rememberClosed(closing);
    for (const t of closing) if (t.kind === "request") void get().saveNow(t.id);
    const tabs = s.tabs.slice(0, idx + 1);
    set({ tabs, active: tabs.some((t) => tabKey(t) === s.active) ? s.active : key });
    persistSession({ ...get() });
  },

  closeAllTabs: () => {
    rememberClosed(get().tabs);
    for (const t of get().tabs) if (t.kind === "request") void get().saveNow(t.id);
    set({ tabs: [], active: null });
    persistSession({ ...get() });
  },

  reopenClosedTab: () => {
    const ws = get().workspace;
    while (closedTabs.length) {
      const tab = closedTabs.pop()!;
      if (ws && tabExists(ws, tab)) return get().openTab(tab);
    }
  },

  setActive: (key) => {
    set({ active: key });
    persistSession({ ...get() });
  },

  moveTab: (from, to) => {
    const tabs = [...get().tabs];
    const [t] = tabs.splice(from, 1);
    tabs.splice(to, 0, t);
    set({ tabs });
    persistSession({ ...get() });
  },

  setEnvironment: (environmentId) => {
    set({ environmentId });
    persistSession({ ...get() });
  },

  setLayout: (layout) => {
    set({ layout });
    writeJson(keys.prefs, { ...readJson<Prefs>(keys.prefs, { layout }), layout });
  },

  updateDraft: (id, update) => {
    const s = get();
    const base = s.drafts[id] ?? findRequest(s.workspace, id)?.request;
    if (!base) return;
    const next = update(base);
    set({ drafts: { ...s.drafts, [id]: next } });
    const existing = saveTimers.get(id);
    if (existing) clearTimeout(existing);
    saveTimers.set(
      id,
      setTimeout(() => void get().saveNow(id), SAVE_DEBOUNCE_MS),
    );
  },

  saveNow: async (id) => {
    const timer = saveTimers.get(id);
    if (!timer && !unsaved.has(id)) return savesInFlight.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    unsaved.delete(id);
    const run = async () => {
      // Read the draft when this save starts, so it carries every edit made while
      // the previous save was in flight.
      const draft = get().drafts[id];
      if (!draft) return;
      set({ saveState: { ...get().saveState, [id]: "saving" } });
      try {
        const { workspace } = await api.saveRequest(draft);
        const { [id]: _, ...saveErrors } = get().saveErrors;
        set({ saveState: { ...get().saveState, [id]: "saved" }, saveErrors });
        if (savesInFlight.get(id) === queued) savesInFlight.delete(id);
        get().applyWorkspace(workspace);
      } catch (err) {
        unsaved.add(id);
        set({ saveState: { ...get().saveState, [id]: "error" }, saveErrors: { ...get().saveErrors, [id]: errorMessage(err) } });
      }
    };
    const queued: Promise<void> = (savesInFlight.get(id) ?? Promise.resolve()).then(run);
    savesInFlight.set(id, queued);
    try {
      await queued;
    } finally {
      if (savesInFlight.get(id) === queued) savesInFlight.delete(id);
    }
  },

  send: async (id) => {
    const s = get();
    const loc = findRequest(s.workspace, id);
    const request = s.drafts[id] ?? loc?.request;
    if (!request) return;
    inflight.get(id)?.abort();
    const controller = new AbortController();
    inflight.set(id, controller);
    const startedAt = Date.now();
    const patch = (next: ResponseState) => {
      // A newer send of the same request owns the panel now.
      if (inflight.get(id) === controller) set({ responses: { ...get().responses, [id]: next } });
    };
    patch({ ...get().responses[id], loading: true, error: undefined, startedAt, live: undefined, events: undefined });
    let live: LiveResponse | undefined;
    let sse: SseParser | undefined;
    let events: SseEvent[] | undefined;
    try {
      const result = await api.sendStream(
        { request, collectionId: loc?.collection.id, environmentId: s.environmentId },
        (e) => {
          if (e.type === "head") {
            const { type: _, ...head } = e;
            live = { ...head, bytes: 0, text: "" };
            // A retried request (e.g. after a token refresh) starts over.
            sse = undefined;
            events = undefined;
            if (isEventStream(head.contentType)) {
              sse = new SseParser();
              events = [];
            }
          } else if (e.type === "chunk" && live) {
            live = { ...live, bytes: e.bytes, text: e.text === undefined ? undefined : (live.text ?? "") + e.text };
            if (sse && e.text) events = [...(events ?? []), ...sse.push(e.text, Date.now() - startedAt)];
          }
          patch({ loading: true, startedAt, live, events });
        },
        controller.signal,
      );
      if (sse) events = [...(events ?? []), ...sse.end(Date.now() - startedAt)];
      patch({ loading: false, response: result.response, events });
      keepResponse(id, result.response, events);
      if (result.workspace) get().applyWorkspace(result.workspace);
      const t = result.oauthRefreshed;
      if (t) {
        // The request's token was refreshed by the server; keep it with the request.
        get().updateDraft(id, (r) =>
          r.auth.type === "oauth2" ? { ...r, auth: { ...r.auth, oauth2: { ...r.auth.oauth2, accessToken: t.accessToken, refreshToken: t.refreshToken || r.auth.oauth2.refreshToken } } } : r,
        );
      }
      recordHistory(id, request, result.response);
    } catch (err) {
      const aborted = controller.signal.aborted;
      if (aborted && live && inflight.get(id) === controller) {
        // Stopped while the body was arriving (e.g. an endless stream): keep what came in.
        const response = stoppedResponse(request, live, Date.now() - startedAt);
        if (sse) events = [...(events ?? []), ...sse.end(Date.now() - startedAt)];
        patch({ loading: false, response, events });
        keepResponse(id, response, events);
        recordHistory(id, request, response);
      } else if (inflight.get(id) === controller) {
        // (A send replaced by a newer one of the same request is not worth reporting.)
        const error = aborted ? "Request cancelled" : errorMessage(err);
        patch({ loading: false, error });
        useConsole.getState().add({
          ...entryFromResponse(request.name, { ...stoppedResponse(request, { statusCode: 0, reasonPhrase: "", headers: [], contentType: "", firstByteMs: 0, bytes: 0 }, Date.now() - startedAt), scriptLogs: [] }),
          error,
          incomplete: undefined,
        });
      }
    } finally {
      if (inflight.get(id) === controller) inflight.delete(id);
    }
  },

  cancel: (id) => {
    inflight.get(id)?.abort();
  },

  restoreResponse: async (id) => {
    const root = get().workspace?.rootPath;
    if (!root || get().responses[id]) return;
    const kept = await loadResponse(root, id);
    if (!kept || get().responses[id] || get().workspace?.rootPath !== root) return;
    set({ responses: { ...get().responses, [id]: { loading: false, response: kept.response, events: kept.events, restoredAt: kept.savedAt } } });
  },

  clearHistory: () => {
    set({ history: [] });
    const root = get().workspace?.rootPath;
    if (root) writeJson(keys.history(root), []);
  },
}));

function keepResponse(requestId: string, response: YamletResponse, events?: SseEvent[]): void {
  const root = useStore.getState().workspace?.rootPath;
  if (root) void saveResponse(root, requestId, response, events);
}

function recordHistory(requestId: string, request: YamletRequest, r: YamletResponse): void {
  useConsole.getState().add(entryFromResponse(request.name, r));
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    requestId,
    name: request.name,
    method: r.method || request.method,
    url: r.resolvedUrl || request.url,
    status: r.statusCode,
    durationMs: r.durationMs,
    isError: r.isError,
    ...(JSON.stringify(request).length <= MAX_SNAPSHOT_CHARS ? { snapshot: request } : {}),
  };
  // Older entries drop their snapshots once the list passes its budget; the rows stay.
  let budget = HISTORY_BUDGET_CHARS;
  const history = [entry, ...useStore.getState().history].slice(0, HISTORY_LIMIT).map((h) => {
    if (!h.snapshot) return h;
    budget -= JSON.stringify(h.snapshot).length;
    if (budget >= 0) return h;
    const { snapshot: _drop, ...row } = h;
    return row;
  });
  useStore.setState({ history });
  const root = useStore.getState().workspace?.rootPath;
  if (root) writeJson(keys.history(root), history);
}

/** The request as currently edited (draft) or as saved. */
export function useRequest(id: string): YamletRequest | undefined {
  return useStore((s) => s.drafts[id] ?? findRequest(s.workspace, id)?.request);
}

export function useActiveEnvironment() {
  return useStore((s) => s.workspace?.environments.find((e) => e.id === s.environmentId));
}
