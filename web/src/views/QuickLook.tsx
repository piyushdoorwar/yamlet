import type { Variable } from "@core/models";
import clsx from "clsx";
import { Eye, EyeOff, HardDrive, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Tab, tabKey, useStore } from "../lib/store";
import { findFolder, findRequest } from "../lib/tree";

interface Scope {
  title: string;
  tab?: Tab;
  vars: Variable[];
}

/** The collection the active tab belongs to, if any. */
function useActiveCollectionId(): string | undefined {
  return useStore((s) => {
    const tab = s.tabs.find((t) => tabKey(t) === s.active);
    if (!tab) return undefined;
    if (tab.kind === "request") return findRequest(s.workspace, tab.id)?.collection.id;
    if (tab.kind === "folder") return findFolder(s.workspace, tab.id)?.collection.id;
    if (tab.kind === "collection" || tab.kind === "runner") return tab.id;
    return undefined;
  });
}

/** Variables in effect for the active tab, highest precedence first, with a link to edit each scope. */
export function QuickLook({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const environmentId = useStore((s) => s.environmentId);
  const openTab = useStore((s) => s.openTab);
  const collectionId = useActiveCollectionId();
  const [q, setQ] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();

  useEffect(() => {
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchor]);

  const env = workspace?.environments.find((e) => e.id === environmentId);
  const collection = workspace?.collections.find((c) => c.id === collectionId);
  const scopes: Scope[] = [
    ...(collection ? [{ title: `Collection: ${collection.name}`, tab: { kind: "collection", id: collection.id } as Tab, vars: collection.variables }] : []),
    { title: env ? `Environment: ${env.name}` : "Environment: none selected", tab: env ? ({ kind: "environment", id: env.id } as Tab) : undefined, vars: env?.variables ?? [] },
    { title: "Globals", tab: { kind: "globals", id: "globals" }, vars: workspace?.globals ?? [] },
  ];
  // Collection beats environment beats globals; a hidden duplicate shows as overridden.
  const seen = new Set<string>();
  const needle = q.trim().toLowerCase();

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="Variables in effect"
      className="fixed z-[70] flex max-h-[70vh] w-[26rem] flex-col rounded-lg border border-line bg-surface shadow-lg"
      style={{ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - 416, window.innerWidth - 424)) }}
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <Search size={14} className="text-muted" aria-hidden />
        <input autoFocus className="h-7 flex-1 bg-transparent text-13 outline-none placeholder:text-placeholder" placeholder="Filter variables" value={q} aria-label="Filter variables" onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {scopes.map((scope) => {
          const rows = scope.vars.filter((v) => v.key && (!needle || v.key.toLowerCase().includes(needle) || (!v.secret && v.value.toLowerCase().includes(needle))));
          const block = (
            <section key={scope.title} className="px-3 py-2">
              <header className="mb-1 flex items-center justify-between">
                <h3 className="truncate text-11 font-medium tracking-wide text-muted uppercase">{scope.title}</h3>
                {scope.tab && (
                  <button type="button" className="shrink-0 text-12 font-medium text-primary hover:underline" onClick={() => (openTab(scope.tab!), onClose())}>
                    Edit
                  </button>
                )}
              </header>
              {rows.length === 0 ? (
                <p className="text-12 text-muted italic">{scope.vars.length ? "No matches" : "No variables"}</p>
              ) : (
                <ul>
                  {rows.map((v) => {
                    const id = `${scope.title}:${v.key}`;
                    const shadowed = v.enabled !== false && seen.has(v.key);
                    const hidden = v.secret && !revealed.has(id);
                    return (
                      <li key={id} className={clsx("flex items-center gap-2 py-0.5 text-12", (v.enabled === false || shadowed) && "opacity-50")}>
                        <span className={clsx("w-36 shrink-0 truncate font-mono text-ink", shadowed && "line-through")} title={shadowed ? `${v.key} (a higher scope overrides this)` : v.key}>
                          {v.key}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-body" title={hidden ? undefined : v.value}>
                          {hidden ? "••••••••" : v.value || <span className="text-placeholder italic">empty</span>}
                        </span>
                        {v.local && <HardDrive size={12} className="shrink-0 text-muted" aria-label="Kept on this machine" />}
                        {v.secret && (
                          <button
                            type="button"
                            className="shrink-0 text-muted hover:text-primary"
                            aria-label={hidden ? `Show ${v.key}` : `Hide ${v.key}`}
                            onClick={() => setRevealed((r) => new Set(hidden ? [...r, id] : [...r].filter((x) => x !== id)))}
                          >
                            {hidden ? <Eye size={12} aria-hidden /> : <EyeOff size={12} aria-hidden />}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
          for (const v of scope.vars) if (v.enabled !== false && v.key) seen.add(v.key);
          return block;
        })}
      </div>
      <p className="border-t border-line-soft px-3 py-2 text-11 text-muted">Request variables and runner data rows take precedence over these.</p>
    </div>,
    document.body,
  );
}
