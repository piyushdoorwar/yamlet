import { useEffect, useRef } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { AboutModal } from "../modals/AboutModal";
import { CookiesModal } from "../modals/CookiesModal";
import { ImportModal } from "../modals/ImportModal";
import { OpenWorkspaceModal } from "../modals/OpenWorkspaceModal";
import { QuickOpen } from "../modals/QuickOpen";
import { SettingsModal } from "../modals/SettingsModal";
import { ShortcutsModal } from "../modals/ShortcutsModal";
import { SnippetModal } from "../modals/SnippetModal";
import { useConsole } from "../lib/consoleLog";
import { tabKey, useStore } from "../lib/store";
import { findFolder, findRequest } from "../lib/tree";
import { useActions } from "../lib/useActions";
import { useUi } from "../lib/ui";
import { Sidebar } from "../sidebar/Sidebar";
import { ConsolePanel } from "./ConsolePanel";
import { StatusBar } from "./StatusBar";
import { TabContent } from "./TabContent";
import { TopBar } from "./TopBar";

function useShortcuts() {
  const actions = useActions();
  // The keydown handler is installed once; it reads the latest actions through refs.
  const newRequestRef = useRef(actions.newRequest);
  const newCollectionRef = useRef(actions.newCollection);
  newRequestRef.current = actions.newRequest;
  newCollectionRef.current = actions.newCollection;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = useStore.getState();
      const activeTab = s.tabs.find((t) => tabKey(t) === s.active);
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUi.getState().setModal({ kind: "quickOpen" });
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTab?.kind === "request") void s.saveNow(activeTab.id);
      } else if (mod && e.key === "Enter") {
        // The URL bar's editor already sent it.
        if (activeTab?.kind === "request" && !e.defaultPrevented) {
          e.preventDefault();
          void s.send(activeTab.id);
        }
      } else if (e.altKey && e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        s.reopenClosedTab();
      } else if (e.altKey && !e.shiftKey && e.code === "KeyN") {
        // A new request beside the active one, or in the first collection.
        e.preventDefault();
        const loc = activeTab?.kind === "request" ? findRequest(s.workspace, activeTab.id) : undefined;
        const collectionId =
          loc?.collection.id ??
          (activeTab?.kind === "collection" ? activeTab.id : activeTab?.kind === "folder" ? findFolder(s.workspace, activeTab.id)?.collection.id : undefined) ??
          s.workspace?.collections[0]?.id;
        const folderId = loc ? (loc.folders.at(-1)?.id ?? null) : activeTab?.kind === "folder" ? activeTab.id : null;
        if (collectionId) void newRequestRef.current?.(collectionId, folderId);
        else void newCollectionRef.current?.();
      } else if (e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (s.active) s.closeTab(s.active);
      } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft") && s.tabs.length > 1) {
        e.preventDefault();
        const i = s.tabs.findIndex((t) => tabKey(t) === s.active);
        const n = (i + (e.key === "ArrowRight" ? 1 : -1) + s.tabs.length) % s.tabs.length;
        s.setActive(tabKey(s.tabs[n]));
      } else if (mod && e.altKey && e.code === "KeyC") {
        e.preventDefault();
        const c = useConsole.getState();
        c.setOpen(!c.open);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useUi.getState().setModal({ kind: "settings" });
      } else if (mod && e.key === "/") {
        e.preventDefault();
        useUi.getState().setModal({ kind: "shortcuts" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function Modals() {
  const modal = useUi((s) => s.modal);
  const close = () => useUi.getState().setModal(null);
  switch (modal?.kind) {
    case "import":
      return <ImportModal onClose={close} />;
    case "cookies":
      return <CookiesModal onClose={close} />;
    case "about":
      return <AboutModal onClose={close} />;
    case "quickOpen":
      return <QuickOpen onClose={close} />;
    case "openWorkspace":
      return <OpenWorkspaceModal onClose={close} />;
    case "shortcuts":
      return <ShortcutsModal onClose={close} />;
    case "settings":
      return <SettingsModal onClose={close} />;
    case "snippet":
      return <SnippetModal requestId={modal.requestId} onClose={close} />;
    default:
      return null;
  }
}

/** Tabs above, the console below it when open. */
function MainArea() {
  const consoleOpen = useConsole((s) => s.open);
  const layout = useDefaultLayout({ id: "yamlet-main", storage: localStorage });
  const tabs = (
    <main className="h-full bg-canvas">
      <TabContent />
    </main>
  );
  if (!consoleOpen) return <div className="min-h-0 flex-1">{tabs}</div>;
  return (
    <div className="min-h-0 flex-1">
      <Group orientation="vertical" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
        <Panel id="tabs" minSize={160}>
          {tabs}
        </Panel>
        <Separator className="h-px" />
        <Panel id="console" defaultSize={240} minSize={100}>
          <ConsolePanel />
        </Panel>
      </Group>
    </div>
  );
}

export function Workbench() {
  useShortcuts();
  const layout = useDefaultLayout({ id: "yamlet-shell", storage: localStorage });
  return (
    <div className="flex h-full flex-col overflow-hidden bg-page">
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
          <Panel id="sidebar" defaultSize={300} minSize={220} maxSize={560}>
            <Sidebar />
          </Panel>
          <Separator className="w-px" />
          <Panel id="main" minSize={420}>
            <div className="flex h-full min-w-0 flex-col">
              <TopBar />
              <MainArea />
            </div>
          </Panel>
        </Group>
      </div>
      <StatusBar />
      <Modals />
    </div>
  );
}
