// Per-browser conveniences (open tabs, chosen environment, history). Workspace
// content itself always lives on disk, so losing this only loses UI state.

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy mode: UI state just won't persist.
  }
}

export const keys = {
  recent: "yamlet.recentWorkspaces",
  session: (root: string) => `yamlet.session:${root}`,
  history: (root: string) => `yamlet.history:${root}`,
  prefs: "yamlet.prefs",
};
