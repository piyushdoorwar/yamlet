import clsx from "clsx";
import { ChevronDown, ChevronLeft, ChevronRight, Globe, Layers, Play, Folder, Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MethodLabel } from "../components/Labels";
import { useMenu } from "../components/Menu";
import { type Tab, tabKey, useStore } from "../lib/store";
import { findFolder, findRequest } from "../lib/tree";

const NONE: never[] = [];

function useTabLabel(tab: Tab): { label: string; icon: React.ReactNode; saving?: boolean } {
  const workspace = useStore((s) => s.workspace);
  const draft = useStore((s) => (tab.kind === "request" ? s.drafts[tab.id] : undefined));
  const saveState = useStore((s) => (tab.kind === "request" ? s.saveState[tab.id] : undefined));
  switch (tab.kind) {
    case "request": {
      const r = draft ?? findRequest(workspace, tab.id)?.request;
      return { label: r?.name ?? "Request", icon: <MethodLabel method={r?.method ?? "GET"} short />, saving: saveState === "saving" };
    }
    case "collection":
      return { label: workspace?.collections.find((c) => c.id === tab.id)?.name ?? "Collection", icon: <Layers size={14} aria-hidden /> };
    case "folder":
      return { label: findFolder(workspace, tab.id)?.folder.name ?? "Folder", icon: <Folder size={14} aria-hidden /> };
    case "runner": {
      const c = workspace?.collections.find((x) => x.id === tab.id);
      const f = tab.folderId ? findFolder(workspace, tab.folderId)?.folder : undefined;
      return { label: `Run ${f?.name ?? c?.name ?? ""}`, icon: <Play size={13} aria-hidden /> };
    }
    case "environment":
      return { label: workspace?.environments.find((e) => e.id === tab.id)?.name ?? "Environment", icon: <SlidersHorizontal size={14} aria-hidden /> };
    case "globals":
      return { label: "Globals", icon: <Globe size={14} aria-hidden /> };
  }
}

function TabItem({ tab, index, menu }: { tab: Tab; index: number; menu: ReturnType<typeof useMenu> }) {
  const key = tabKey(tab);
  const active = useStore((s) => s.active === key);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);
  const closeOthers = useStore((s) => s.closeOtherTabs);
  const closeRight = useStore((s) => s.closeTabsToRight);
  const closeAll = useStore((s) => s.closeAllTabs);
  const moveTab = useStore((s) => s.moveTab);
  const { label, icon, saving } = useTabLabel(tab);
  return (
    <div
      role="tab"
      data-tab-key={key}
      aria-selected={active}
      tabIndex={0}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("application/x-yamlet-tab", String(index))}
      onDragOver={(e) => e.dataTransfer.types.includes("application/x-yamlet-tab") && e.preventDefault()}
      onDrop={(e) => {
        const from = Number(e.dataTransfer.getData("application/x-yamlet-tab"));
        if (!Number.isNaN(from) && from !== index) moveTab(from, index);
      }}
      onClick={() => setActive(key)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setActive(key)}
      onAuxClick={(e) => e.button === 1 && closeTab(key)}
      onContextMenu={(e) =>
        menu.openAt(e, [
          { label: "Close", onSelect: () => closeTab(key), hint: "Alt W" },
          { label: "Close other tabs", onSelect: () => closeOthers(key) },
          { label: "Close tabs to the right", onSelect: () => closeRight(key) },
          "separator",
          { label: "Close all tabs", onSelect: () => closeAll() },
        ])
      }
      title={label}
      className={clsx(
        "group relative flex h-full max-w-56 min-w-28 shrink-0 cursor-pointer items-center gap-2 border-r border-line-soft px-3 text-13",
        active ? "bg-canvas text-ink" : "bg-white text-grey hover:bg-[#fafbfa] hover:text-ink",
      )}
    >
      {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
      <span className="flex shrink-0 items-center text-grey">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        {saving && <span className="absolute h-1.5 w-1.5 rounded-full bg-primary group-hover:hidden" aria-label="Saving" />}
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            closeTab(key);
          }}
          className={clsx("rounded p-0.5 text-muted hover:bg-line-soft hover:text-ink", active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
        >
          <X size={13} aria-hidden />
        </button>
      </span>
    </div>
  );
}

/** Lists every open tab, filterable, for when the strip is too crowded to scan. */
function AllTabs({ onClose, anchor }: { onClose: () => void; anchor: HTMLElement }) {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);
  const closeAll = useStore((s) => s.closeAllTabs);
  const [q, setQ] = useState("");
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

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="Open tabs"
      className="fixed z-[70] flex max-h-[70vh] w-80 flex-col rounded-lg border border-line bg-white shadow-lg"
      style={{ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328)) }}
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <Search size={14} className="text-muted" aria-hidden />
        <input autoFocus className="h-7 flex-1 bg-transparent text-13 outline-none placeholder:text-[#a3aea7]" placeholder={`Filter ${tabs.length} open tabs`} value={q} aria-label="Filter open tabs" onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {tabs.map((t) => (
          <AllTabsRow key={tabKey(t)} tab={t} q={q.trim().toLowerCase()} active={active === tabKey(t)} onPick={() => (setActive(tabKey(t)), onClose())} onCloseTab={() => closeTab(tabKey(t))} />
        ))}
      </ul>
      <div className="flex justify-end border-t border-line-soft px-3 py-2">
        <button type="button" className="text-12 text-muted hover:text-danger" onClick={() => (closeAll(), onClose())}>
          Close all tabs
        </button>
      </div>
    </div>,
    document.body,
  );
}

function AllTabsRow({ tab, q, active, onPick, onCloseTab }: { tab: Tab; q: string; active: boolean; onPick: () => void; onCloseTab: () => void }) {
  const { label, icon } = useTabLabel(tab);
  if (q && !label.toLowerCase().includes(q)) return null;
  return (
    <li className={clsx("group flex items-center gap-2 px-3 py-1.5", active ? "bg-primary-soft" : "hover:bg-[#fafbfa]")}>
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 items-center gap-2 text-left text-13 text-body">
        <span className="flex w-9 shrink-0 justify-end text-grey">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      <button type="button" aria-label={`Close ${label}`} onClick={onCloseTab} className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:text-ink focus:opacity-100">
        <X size={13} aria-hidden />
      </button>
    </li>
  );
}

export function TopBar() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const environments = useStore((s) => s.workspace?.environments) ?? NONE;
  const environmentId = useStore((s) => s.environmentId);
  const setEnvironment = useStore((s) => s.setEnvironment);
  const openTab = useStore((s) => s.openTab);
  const menu = useMenu();
  const strip = useRef<HTMLDivElement>(null);
  const listBtn = useRef<HTMLButtonElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [listOpen, setListOpen] = useState(false);

  const updateEdges = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    // A vertical wheel scrolls the strip sideways.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [updateEdges]);

  // Keep the active tab in view when it changes or tabs are added.
  useEffect(() => {
    const el = strip.current;
    const tab = active ? el?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(active)}"]`) : null;
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateEdges();
  }, [active, tabs.length, updateEdges]);

  const nudge = (dir: -1 | 1) => strip.current?.scrollBy({ left: dir * Math.max(200, (strip.current.clientWidth ?? 400) * 0.6), behavior: "smooth" });

  return (
    <header className="flex h-12 shrink-0 items-stretch border-b border-line-soft bg-white">
      <div className="relative flex min-w-0 flex-1">
        <div ref={strip} role="tablist" aria-label="Open tabs" onScroll={updateEdges} className="no-scrollbar flex min-w-0 flex-1 scroll-px-8 items-stretch overflow-x-auto">
          {tabs.map((t, i) => (
            <TabItem key={tabKey(t)} tab={t} index={i} menu={menu} />
          ))}
        </div>
        {edges.left && (
          <button type="button" aria-label="Scroll tabs left" onClick={() => nudge(-1)} className="absolute inset-y-0 left-0 flex w-8 items-center justify-start bg-gradient-to-r from-white via-white/90 to-transparent pl-1 text-grey hover:text-primary">
            <ChevronLeft size={16} aria-hidden />
          </button>
        )}
        {edges.right && (
          <button type="button" aria-label="Scroll tabs right" onClick={() => nudge(1)} className="absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-white via-white/90 to-transparent pr-1 text-grey hover:text-primary">
            <ChevronRight size={16} aria-hidden />
          </button>
        )}
      </div>
      {tabs.length > 1 && (
        <div className="flex shrink-0 items-center border-l border-line-soft px-1.5">
          <button
            ref={listBtn}
            type="button"
            aria-label={`All open tabs (${tabs.length})`}
            title="All open tabs"
            aria-haspopup="dialog"
            aria-expanded={listOpen}
            onClick={() => setListOpen((o) => !o)}
            className={clsx("flex h-8 items-center gap-1 rounded-md px-2 text-12 font-medium", listOpen ? "bg-primary-soft text-primary" : "text-grey hover:bg-primary-soft hover:text-primary")}
          >
            {tabs.length}
            <ChevronDown size={14} aria-hidden />
          </button>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-l border-line-soft px-3">
        <label htmlFor="env-select" className="sr-only">
          Active environment
        </label>
        <select id="env-select" className="input h-8 w-48 text-12" value={environmentId ?? ""} onChange={(e) => setEnvironment(e.target.value || null)}>
          <option value="">No environment</option>
          {environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Edit active environment"
          title="Edit active environment"
          disabled={!environmentId}
          className="rounded-md p-1.5 text-grey hover:bg-primary-soft hover:text-primary disabled:opacity-30"
          onClick={() => environmentId && openTab({ kind: "environment", id: environmentId })}
        >
          <SlidersHorizontal size={15} aria-hidden />
        </button>
      </div>
      {menu.node}
      {listOpen && listBtn.current && <AllTabs anchor={listBtn.current} onClose={() => setListOpen(false)} />}
    </header>
  );
}
