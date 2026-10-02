import type { ServerInfo } from "../../../shared/api";
import type { YamletRequest, YamletResponse, YamletWorkspace } from "@core/models";
import { create } from "zustand";
import { api, errorMessage, setApiWorkspace } from "./api";
import { keys, readJson, writeJson } from "./storage";
import { findFolder, findRequest } from "./tree";

export type TabKind = "request" | "collection" | "folder" | "environment" | "globals" | "runner";

export interface Tab {
  kind: TabKind;
  /** Item id (request / collection / folder / environment); "globals" for globals. */
  id: string;
  /** runner: optional folder scope. */
  folderId?: string;
}

export const tabKey = (t: Tab) => `${t.kind}:${t.id}${t.folderId ? `:${t.folderId}` : ""}`;

export interface ResponseState {
  loading: boolean;
  response?: YamletResponse;
  error?: string;
  startedAt?: number;
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
  /** Snapshot of the request as sent, so it can be reopened even if edited since. */
  snapshot: YamletRequest;
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
  setActive: (key: string) => void;
  moveTab: (from: number, to: number) => void;

  setEnvironment: (id: string | null) => void;
  setLayout: (layout: ResponseLayout) => void;

  updateDraft: (id: string, update: (r: YamletRequest) => YamletRequest) => void;
  saveNow: (id: string) => Promise<void>;

  send: (id: string) => Promise<void>;
  cancel: (id: string) => void;
  clearHistory: () => void;
}

const SAVE_DEBOUNCE_MS = 500;
const HISTORY_LIMIT = 150;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, AbortController>();

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

export const useStore = create<State>((set, get) => ({
  info: null,
  workspace: null,
  loadError: null,
  tabs: [],
  active: null,
  environmentId: null,
  drafts: {},
  saveState: {},
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
      const pending = saveTimers.has(id);
      drafts[id] = pending ? { ...draft, sourceFilePath: loc.request.sourceFilePath } : loc.request;
    }
    const environmentId = ws.environments.some((e) => e.id === s.environmentId) ? s.environmentId : (ws.environments[0]?.id ?? null);
    set({ workspace: ws, tabs, active, drafts, environmentId });
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
    if (closing.kind === "request") void get().saveNow(closing.id);
    const tabs = s.tabs.filter((_, i) => i !== idx);
    const active = s.active === key ? (tabs[Math.min(idx, tabs.length - 1)] ? tabKey(tabs[Math.min(idx, tabs.length - 1)]) : null) : s.active;
    set({ tabs, active });
    persistSession({ ...get() });
  },

  closeOtherTabs: (key) => {
    const s = get();
    for (const t of s.tabs) if (t.kind === "request" && tabKey(t) !== key) void get().saveNow(t.id);
    set({ tabs: s.tabs.filter((t) => tabKey(t) === key), active: key });
    persistSession({ ...get() });
  },

  closeTabsToRight: (key) => {
    const s = get();
    const idx = s.tabs.findIndex((t) => tabKey(t) === key);
    if (idx < 0) return;
    const closing = s.tabs.slice(idx + 1);
    for (const t of closing) if (t.kind === "request") void get().saveNow(t.id);
    const tabs = s.tabs.slice(0, idx + 1);
    set({ tabs, active: tabs.some((t) => tabKey(t) === s.active) ? s.active : key });
    persistSession({ ...get() });
  },

  closeAllTabs: () => {
    for (const t of get().tabs) if (t.kind === "request") void get().saveNow(t.id);
    set({ tabs: [], active: null });
    persistSession({ ...get() });
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
    if (!timer) return;
    clearTimeout(timer);
    saveTimers.delete(id);
    const draft = get().drafts[id];
    if (!draft) return;
    set({ saveState: { ...get().saveState, [id]: "saving" } });
    try {
      const { workspace } = await api.saveRequest(draft);
      set({ saveState: { ...get().saveState, [id]: "saved" } });
      get().applyWorkspace(workspace);
    } catch (err) {
      set({ saveState: { ...get().saveState, [id]: "error" } });
      console.error("Save failed", errorMessage(err));
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
    set({ responses: { ...get().responses, [id]: { ...get().responses[id], loading: true, error: undefined, startedAt: Date.now() } } });
    try {
      const result = await api.send({ request, collectionId: loc?.collection.id, environmentId: s.environmentId }, controller.signal);
      set({ responses: { ...get().responses, [id]: { loading: false, response: result.response } } });
      if (result.workspace) get().applyWorkspace(result.workspace);
      const r = result.response;
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        at: Date.now(),
        requestId: id,
        name: request.name,
        method: r.method || request.method,
        url: r.resolvedUrl || request.url,
        status: r.statusCode,
        durationMs: r.durationMs,
        isError: r.isError,
        snapshot: request,
      };
      const history = [entry, ...get().history].slice(0, HISTORY_LIMIT);
      set({ history });
      const root = get().workspace?.rootPath;
      if (root) writeJson(keys.history(root), history);
    } catch (err) {
      const aborted = controller.signal.aborted;
      set({ responses: { ...get().responses, [id]: { loading: false, error: aborted ? "Request cancelled" : errorMessage(err) } } });
    } finally {
      if (inflight.get(id) === controller) inflight.delete(id);
    }
  },

  cancel: (id) => {
    inflight.get(id)?.abort();
  },

  clearHistory: () => {
    set({ history: [] });
    const root = get().workspace?.rootPath;
    if (root) writeJson(keys.history(root), []);
  },
}));

/** The request as currently edited (draft) or as saved. */
export function useRequest(id: string): YamletRequest | undefined {
  return useStore((s) => s.drafts[id] ?? findRequest(s.workspace, id)?.request);
}

export function useActiveEnvironment() {
  return useStore((s) => s.workspace?.environments.find((e) => e.id === s.environmentId));
}
