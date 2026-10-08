import { Clock, FolderOpen, FolderPlus } from "lucide-react";
import { useState } from "react";
import type { FsListing } from "../../../shared/api";
import { Button } from "../components/Button";
import { FolderBrowser } from "../components/FolderBrowser";
import { Wordmark } from "../components/Logo";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { recentWorkspaces, useStore } from "../lib/store";

export function useWorkspaceOpener() {
  const loadWorkspace = useStore((s) => s.loadWorkspace);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => ReturnType<typeof api.openWorkspace>) => {
    setBusy(true);
    try {
      const { workspace } = await fn();
      loadWorkspace(workspace);
      return true;
    } catch (err) {
      toast.error("Could not open the workspace", errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    open: (path: string) => run(() => api.openWorkspace(path)),
    create: (path: string) => run(() => api.createWorkspace(path)),
  };
}

/** Shown when no workspace is open: pick a folder, or turn one into a workspace. */
export function WorkspacePicker({ onDone }: { onDone?: () => void }) {
  const info = useStore((s) => s.info);
  const [listing, setListing] = useState<FsListing | null>(null);
  const { busy, open, create } = useWorkspaceOpener();
  const recent = recentWorkspaces();

  return (
    <div className="grid min-h-0 gap-5 md:grid-cols-[1fr_240px]">
      <div className="flex min-h-0 flex-col">
        <FolderBrowser start={info?.defaultWorkspace ?? undefined} onNavigate={setListing} className="h-80" />
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          <Button
            variant="cancel"
            icon={FolderPlus}
            disabled={!listing || listing.isWorkspace || busy}
            onClick={async () => listing && (await create(listing.path)) && onDone?.()}
            title="Create collections/, environments/ and globals/ in this folder"
          >
            Make this a workspace
          </Button>
          <Button icon={FolderOpen} disabled={!listing?.isWorkspace || busy} onClick={async () => listing && (await open(listing.path)) && onDone?.()}>
            Open workspace
          </Button>
        </div>
      </div>
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-12 font-medium tracking-wide text-muted uppercase">
          <Clock size={13} aria-hidden /> Recent
        </h3>
        {recent.length === 0 ? (
          <p className="text-13 text-muted italic">No recent workspaces.</p>
        ) : (
          <ul className="space-y-1">
            {recent.map((w) => (
              <li key={w.root}>
                <button
                  type="button"
                  className="w-full rounded-md px-2.5 py-2 text-left hover:bg-primary-soft"
                  onClick={async () => (await open(w.root)) && onDone?.()}
                  title={w.root}
                >
                  <span className="block truncate text-13 font-medium text-ink">{w.name}</span>
                  <span className="block truncate font-mono text-11 text-muted">{w.root}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function WelcomeView({ bootError }: { bootError: string | null }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-3xl rounded-xl border border-line bg-surface p-8 shadow-sm">
        <Wordmark />
        <h1 className="mt-6 text-xl font-medium text-ink">Open a workspace</h1>
        <p className="mt-1 mb-6 text-13 text-muted">
          A workspace is a folder of plain YAML files: <span className="font-mono">collections/</span>, <span className="font-mono">environments/</span> and{" "}
          <span className="font-mono">globals/</span>. Commit it to Git like any other code.
        </p>
        {bootError && (
          <div role="alert" className="mb-4 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-13 text-danger">
            Could not reach the Yamlet server: {bootError}
          </div>
        )}
        <WorkspacePicker />
      </div>
    </div>
  );
}
