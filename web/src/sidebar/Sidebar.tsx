import { ChevronsUpDown, Download, FilePlus, FolderOpen, Layers, Plus, RefreshCw, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { IconButton } from "../components/Button";
import { Wordmark } from "../components/Logo";
import { useMenu } from "../components/Menu";
import { TabButton } from "../components/Tabs";
import { useStore } from "../lib/store";
import { type SidebarSection, useUi } from "../lib/ui";
import { useActions } from "../lib/useActions";
import { CollectionsTree } from "./CollectionsTree";
import { EnvironmentsList } from "./EnvironmentsList";
import { HistoryList } from "./HistoryList";

const SECTIONS: { id: SidebarSection; label: string }[] = [
  { id: "collections", label: "Collections" },
  { id: "environments", label: "Environments" },
  { id: "history", label: "History" },
];

export function Sidebar() {
  const workspace = useStore((s) => s.workspace)!;
  const section = useUi((s) => s.section);
  const setSection = useUi((s) => s.setSection);
  const setModal = useUi((s) => s.setModal);
  const actions = useActions();
  const [filter, setFilter] = useState("");
  const wsMenu = useMenu();
  const newMenu = useMenu();
  const wsBtn = useRef<HTMLButtonElement>(null);

  const firstCollection = workspace.collections[0];

  return (
    <aside className="flex h-full flex-col bg-white shadow-[1px_0_0_#f1f4f2]">
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <Wordmark />
      </div>

      <div className="px-4">
        <button
          ref={wsBtn}
          type="button"
          title={workspace.rootPath}
          className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left hover:border-[#c5d0c9]"
          onClick={() =>
            wsBtn.current &&
            wsMenu.openBelow(wsBtn.current, [
              { label: "Open another workspace", icon: FolderOpen, onSelect: () => setModal({ kind: "openWorkspace" }) },
              { label: "Reload from disk", icon: RefreshCw, onSelect: () => void actions.reload() },
            ])
          }
        >
          <span className="min-w-0 flex-1">
            <span className="block text-11 tracking-wide text-muted uppercase">Workspace</span>
            <span className="block truncate text-13 font-medium text-ink">{workspace.name}</span>
          </span>
          <ChevronsUpDown size={15} className="shrink-0 text-muted" aria-hidden />
        </button>
      </div>

      <div className="mt-4 px-4">
        <div className="[&>div]:flex [&>div]:w-full [&_button]:flex-1 [&_button]:px-2">
          <TabButton tabs={SECTIONS} active={section} onChange={setSection} size="sm" />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 px-4 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            className="input h-8 pr-7 pl-8 text-12"
            placeholder={section === "history" ? "Filter history" : section === "environments" ? "Filter environments" : "Filter requests"}
            value={filter}
            aria-label="Filter"
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button type="button" aria-label="Clear filter" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted hover:text-ink" onClick={() => setFilter("")}>
              <X size={13} aria-hidden />
            </button>
          )}
        </div>
        <IconButton icon={Download} label="Import" onClick={() => setModal({ kind: "import" })} />
          <IconButton
            icon={Plus}
            label="New"
            onClick={(e) =>
              newMenu.openBelow(e.currentTarget as HTMLElement, [
                { label: "Collection", icon: Layers, onSelect: () => void actions.newCollection() },
                {
                  label: "Request",
                  icon: FilePlus,
                  disabled: !firstCollection,
                  onSelect: () => firstCollection && void actions.newRequest(firstCollection.id, null),
                },
                { label: "Environment", icon: Layers, onSelect: () => void actions.newEnvironment() },
                "separator",
                { label: "Import…", icon: Download, onSelect: () => setModal({ kind: "import" }) },
              ], "end")
            }
          />
      </div>

      <nav aria-label="Workspace" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-1">
        {section === "collections" && <CollectionsTree actions={actions} filter={filter} />}
        {section === "environments" && <EnvironmentsList actions={actions} filter={filter} />}
        {section === "history" && <HistoryList filter={filter} />}
      </nav>
      {wsMenu.node}
      {newMenu.node}
    </aside>
  );
}
