import { useEffect } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { AboutModal } from "../modals/AboutModal";
import { CookiesModal } from "../modals/CookiesModal";
import { ImportModal } from "../modals/ImportModal";
import { OpenWorkspaceModal } from "../modals/OpenWorkspaceModal";
import { QuickOpen } from "../modals/QuickOpen";
import { ShortcutsModal } from "../modals/ShortcutsModal";
import { SnippetModal } from "../modals/SnippetModal";
import { tabKey, useStore } from "../lib/store";
import { useUi } from "../lib/ui";
import { Sidebar } from "../sidebar/Sidebar";
import { StatusBar } from "./StatusBar";
import { TabContent } from "./TabContent";
import { TopBar } from "./TopBar";

function useShortcuts() {
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
        if (activeTab?.kind === "request") {
          e.preventDefault();
          void s.send(activeTab.id);
        }
      } else if (e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (s.active) s.closeTab(s.active);
      } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft") && s.tabs.length > 1) {
        e.preventDefault();
        const i = s.tabs.findIndex((t) => tabKey(t) === s.active);
        const n = (i + (e.key === "ArrowRight" ? 1 : -1) + s.tabs.length) % s.tabs.length;
        s.setActive(tabKey(s.tabs[n]));
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
    case "snippet":
      return <SnippetModal requestId={modal.requestId} onClose={close} />;
    default:
      return null;
  }
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
              <main className="min-h-0 flex-1 bg-canvas">
                <TabContent />
              </main>
            </div>
          </Panel>
        </Group>
      </div>
      <StatusBar />
      <Modals />
    </div>
  );
}
