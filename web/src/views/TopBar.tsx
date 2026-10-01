import clsx from "clsx";
import { Globe, Layers, Play, Settings2, SlidersHorizontal, X } from "lucide-react";
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
      return { label: findFolder(workspace, tab.id)?.folder.name ?? "Folder", icon: <Settings2 size={14} aria-hidden /> };
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
  const moveTab = useStore((s) => s.moveTab);
  const { label, icon, saving } = useTabLabel(tab);
  return (
    <div
      role="tab"
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

export function TopBar() {
  const tabs = useStore((s) => s.tabs);
  const environments = useStore((s) => s.workspace?.environments) ?? NONE;
  const environmentId = useStore((s) => s.environmentId);
  const setEnvironment = useStore((s) => s.setEnvironment);
  const openTab = useStore((s) => s.openTab);
  const menu = useMenu();

  return (
    <header className="flex h-12 shrink-0 items-stretch border-b border-line-soft bg-white">
      <div role="tablist" aria-label="Open tabs" className="flex min-w-0 flex-1 items-stretch no-scrollbar overflow-x-auto">
        {tabs.map((t, i) => (
          <TabItem key={tabKey(t)} tab={t} index={i} menu={menu} />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-l border-line-soft px-3">
        <label htmlFor="env-select" className="sr-only">
          Active environment
        </label>
        <select
          id="env-select"
          className="input h-8 w-48 text-12"
          value={environmentId ?? ""}
          onChange={(e) => setEnvironment(e.target.value || null)}
        >
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
    </header>
  );
}
