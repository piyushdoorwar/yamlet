import { useEffect, useState } from "react";
import { DialogProvider } from "./components/Dialogs";
import { ToastProvider } from "./components/Toast";
import { api, errorMessage } from "./lib/api";
import { recentWorkspaces, useStore } from "./lib/store";
import { Workbench } from "./views/Workbench";
import { WelcomeView } from "./views/WelcomeView";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <DialogProvider>{children}</DialogProvider>
    </ToastProvider>
  );
}

/** Opens the container's mounted workspace (or the last one used) on first load. */
function useBoot(): { booting: boolean; bootError: string | null } {
  const setInfo = useStore((s) => s.setInfo);
  const loadWorkspace = useStore((s) => s.loadWorkspace);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api.info();
        if (cancelled) return;
        setInfo(info);
        const candidates = [recentWorkspaces()[0]?.root, info.defaultWorkspace].filter((p): p is string => !!p);
        for (const path of candidates) {
          try {
            const { workspace } = await api.openWorkspace(path);
            if (!cancelled) loadWorkspace(workspace);
            return;
          } catch {
            // Not a workspace (yet) or no longer there: try the next candidate.
          }
        }
      } catch (err) {
        if (!cancelled) setBootError(errorMessage(err));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setInfo, loadWorkspace]);

  return { booting, bootError };
}

export function App() {
  const workspace = useStore((s) => s.workspace);
  const { booting, bootError } = useBoot();

  useEffect(() => {
    document.title = workspace ? `${workspace.name} · Yamlet` : "Yamlet";
  }, [workspace]);

  return (
    <Providers>
      {booting ? (
        <div className="flex h-full items-center justify-center text-13 text-muted">Loading Yamlet…</div>
      ) : workspace ? (
        <Workbench />
      ) : (
        <WelcomeView bootError={bootError} />
      )}
    </Providers>
  );
}
