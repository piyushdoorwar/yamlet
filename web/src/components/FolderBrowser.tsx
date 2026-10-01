import clsx from "clsx";
import { ChevronRight, CornerLeftUp, FileText, Folder, FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FsListing } from "../../../shared/api";
import { api, errorMessage } from "../lib/api";
import { Logo } from "./Logo";

interface Props {
  start?: string;
  /** Show files too, and report the clicked file (file pickers). */
  files?: boolean;
  onPickFile?: (path: string) => void;
  onNavigate?: (listing: FsListing) => void;
  className?: string;
}

/** Server-side folder browser, confined to the server's browse root. */
export function FolderBrowser({ start, files, onPickFile, onNavigate, className }: Props) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const go = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        const next = await api.listDir(path, files);
        setListing(next);
        onNavigate?.(next);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [files, onNavigate],
  );

  useEffect(() => {
    void go(start);
    // Only on mount / when the start folder changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  return (
    <div className={clsx("flex min-h-0 flex-col rounded-lg border border-line bg-white", className)}>
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <button
          type="button"
          className="rounded p-1 text-grey hover:bg-primary-soft hover:text-primary disabled:opacity-30"
          disabled={!listing?.parent}
          aria-label="Parent folder"
          onClick={() => listing?.parent && void go(listing.parent)}
        >
          <CornerLeftUp size={15} aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-12 text-grey" title={listing?.path}>
          {listing?.path ?? "…"}
        </span>
        {loading && <Loader2 size={14} className="spin text-muted" aria-label="Loading" />}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Folder contents">
        {error && <li className="px-4 py-3 text-13 text-danger">{error}</li>}
        {listing && listing.entries.length === 0 && !error && <li className="px-4 py-3 text-13 text-muted italic">This folder is empty.</li>}
        {listing?.entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              onClick={() => (e.kind === "dir" ? void go(e.path) : onPickFile?.(e.path))}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-13 text-body hover:bg-primary-soft"
            >
              {e.kind === "file" ? (
                <FileText size={15} className="shrink-0 text-muted" aria-hidden />
              ) : e.isWorkspace ? (
                <Logo size={15} className="shrink-0" />
              ) : (
                <Folder size={15} className="shrink-0 text-grey" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {e.isWorkspace && <span className="text-11 font-medium text-primary">Workspace</span>}
              {e.kind === "dir" && <ChevronRight size={14} className="text-[#b3bdb7]" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
      {listing?.isWorkspace && (
        <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2 text-12 text-primary">
          <FolderOpen size={14} aria-hidden /> This folder is a Yamlet workspace.
        </div>
      )}
    </div>
  );
}
