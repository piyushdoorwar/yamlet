import { FileUp, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { useStore } from "../lib/store";
import { Button } from "./Button";
import { FolderBrowser } from "./FolderBrowser";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

/** Workspace-relative when the file lives inside the workspace. */
function toWorkspacePath(root: string, abs: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

/** Shows the chosen file path with buttons to pick or clear it. */
export function FileChooser({ value, onChange, compact }: { value: string; onChange: (path: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = value.replace(/^@/, "");
  return (
    <div className="flex min-w-0 items-center gap-2 px-2">
      {shown ? (
        <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-primary-tint px-2 py-1 font-mono text-12 text-primary" title={shown}>
          <Paperclip size={12} className="shrink-0" aria-hidden />
          <span className="truncate">{shown}</span>
          <button type="button" aria-label="Remove file" className="shrink-0 text-primary/70 hover:text-danger" onClick={() => onChange("")}>
            <X size={12} aria-hidden />
          </button>
        </span>
      ) : (
        !compact && <span className="text-12 text-muted">No file selected</span>
      )}
      <button type="button" className="shrink-0 text-12 font-medium text-primary hover:underline" onClick={() => setOpen(true)}>
        {shown ? "Change" : "Select file"}
      </button>
      {open && (
        <FilePickerModal
          onClose={() => setOpen(false)}
          onPick={(p) => {
            onChange(p);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function FilePickerModal({ onClose, onPick }: { onClose: () => void; onPick: (path: string) => void }) {
  const root = useStore((s) => s.workspace?.rootPath ?? "");
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const { path } = await api.upload(file);
      onPick(path);
    } catch (err) {
      toast.error("Upload failed", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Attach a file" subtitle="Uploaded files are copied into the workspace's files/ folder, so the request keeps working from Git." onClose={onClose} width={620} tall>
      <div className="flex h-full flex-col gap-4">
        <div className="flex items-center justify-between rounded-lg border border-dashed border-line-strong bg-subtle px-4 py-3">
          <span className="text-13 text-grey">From your computer</span>
          <input ref={input} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <Button icon={FileUp} size="sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploading…" : "Upload file"}
          </Button>
        </div>
        <p className="text-12 text-muted">Or pick a file that's already in the workspace:</p>
        <FolderBrowser start={root} files onPickFile={(abs) => onPick(toWorkspacePath(root, abs))} className="min-h-0 flex-1" />
      </div>
    </Modal>
  );
}
