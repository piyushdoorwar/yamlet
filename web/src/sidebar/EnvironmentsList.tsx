import clsx from "clsx";
import { Check, Copy, Globe, Layers, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useRef } from "react";
import { type MenuEntry, useMenu } from "../components/Menu";
import type { TreeActions } from "../lib/actions";
import { tabKey, useStore } from "../lib/store";
import { useUi } from "../lib/ui";
import { RenameInput } from "./CollectionsTree";

const NONE: never[] = [];

export function EnvironmentsList({ actions, filter }: { actions: TreeActions; filter: string }) {
  const environments = useStore((s) => s.workspace?.environments) ?? NONE;
  const selected = useStore((s) => s.environmentId);
  const active = useStore((s) => s.active);
  const openTab = useStore((s) => s.openTab);
  const setEnvironment = useStore((s) => s.setEnvironment);
  const renaming = useUi((s) => s.renaming);
  const menu = useMenu();
  const q = filter.trim().toLowerCase();
  const visible = environments.filter((e) => !q || e.name.toLowerCase().includes(q));

  const items = (id: string, name: string): MenuEntry[] => [
    { label: "Set active", icon: Check, onSelect: () => setEnvironment(id) },
    { label: "Rename", icon: Pencil, onSelect: () => useUi.getState().setRenaming(id) },
    { label: "Duplicate", icon: Copy, onSelect: () => void actions.duplicateEnvironment(id) },
    "separator",
    { label: "Delete", icon: Trash2, danger: true, onSelect: () => void actions.deleteEnvironment(id, name) },
  ];

  return (
    <div className="pb-6">
      <button
        type="button"
        onClick={() => openTab({ kind: "globals", id: "globals" })}
        className={clsx(
          "mx-2 flex h-8 w-[calc(100%-16px)] items-center gap-2 rounded-md px-2.5 text-13",
          active === "globals:globals" ? "bg-primary text-white" : "text-body hover:bg-primary-soft",
        )}
      >
        <Globe size={15} aria-hidden /> <span className="flex-1 text-left font-medium">Globals</span>
      </button>
      <p className="mt-3 mb-1 px-4 text-11 font-medium tracking-wide text-muted uppercase">Environments</p>
      {environments.length === 0 && (
        <div className="px-6 py-6 text-center">
          <Layers size={26} className="mx-auto text-[#b9c4bd]" aria-hidden />
          <p className="mt-3 text-13 text-grey">No environments yet.</p>
          <button type="button" className="btn btn-primary btn-sm mt-4" onClick={() => void actions.newEnvironment()}>
            New environment
          </button>
        </div>
      )}
      {visible.map((env) => {
        const isActiveTab = active === tabKey({ kind: "environment", id: env.id });
        return (
          <EnvRow
            key={env.id}
            name={env.name}
            count={env.variables.length}
            current={env.id === selected}
            activeTab={isActiveTab}
            renaming={renaming === env.id}
            onOpen={() => {
              openTab({ kind: "environment", id: env.id });
              setEnvironment(env.id);
            }}
            onRename={(v) => {
              useUi.getState().setRenaming(null);
              if (v && v !== env.name) void actions.renameEnvironment(env.id, v);
            }}
            onMenu={(e) => menu.openAt(e, items(env.id, env.name))}
            onMore={(el) => menu.openBelow(el, items(env.id, env.name), "end")}
          />
        );
      })}
      {menu.node}
    </div>
  );
}

function EnvRow(p: {
  name: string;
  count: number;
  current: boolean;
  activeTab: boolean;
  renaming: boolean;
  onOpen: () => void;
  onRename: (v: string | null) => void;
  onMenu: (e: React.MouseEvent) => void;
  onMore: (el: HTMLElement) => void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  return (
    <div
      className={clsx("group mx-2 flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-13", p.activeTab ? "bg-primary text-white" : "text-body hover:bg-primary-soft")}
      onClick={p.onOpen}
      onContextMenu={p.onMenu}
    >
      <span className={clsx("h-2 w-2 shrink-0 rounded-full", p.current ? (p.activeTab ? "bg-white" : "bg-primary") : "border border-[#b9c4bd]")} aria-label={p.current ? "Active environment" : undefined} />
      {p.renaming ? (
        <RenameInput initial={p.name} onDone={p.onRename} />
      ) : (
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
      )}
      <span className={clsx("text-11", p.activeTab ? "text-white/80" : "text-muted")}>{p.count}</span>
      <button
        ref={more}
        type="button"
        aria-label={`Actions for ${p.name}`}
        className={clsx("rounded p-1 opacity-0 group-hover:opacity-100 focus:opacity-100", p.activeTab ? "text-white" : "text-grey hover:bg-white")}
        onClick={(e) => {
          e.stopPropagation();
          if (more.current) p.onMore(more.current);
        }}
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
    </div>
  );
}
