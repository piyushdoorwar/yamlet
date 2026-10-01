import { detectImportFormat } from "@core/importers";
import { FileUp } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { CodeEditor } from "../editor/CodeEditor";
import { api, errorMessage } from "../lib/api";
import { useStore } from "../lib/store";
import { useUi } from "../lib/ui";

const FORMAT_LABEL: Record<string, string> = {
  "collection-v2": "Collection (v2.1 JSON export)",
  environment: "Environment (JSON export)",
  openapi: "OpenAPI / Swagger document",
  curl: "cURL command",
  unknown: "Unrecognised format",
};

export function ImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const collections = useStore((s) => s.workspace?.collections);
  const [target, setTarget] = useState(collections?.[0]?.id ?? "");
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const format = useMemo(() => (text.trim() ? detectImportFormat(text) : null), [text]);

  const submit = async () => {
    setBusy(true);
    try {
      const s = useStore.getState();
      const ui = useUi.getState();
      if (format === "curl") {
        if (!target) throw new Error("Create a collection first, then import the cURL command into it.");
        const res = await api.importText(text, fileName);
        if (res.kind !== "request") throw new Error("Unexpected import result");
        const { id: _id, sourceFilePath: _p, ...init } = res.request;
        const created = await api.createRequest(target, null, init);
        s.applyWorkspace(created.workspace);
        ui.toggle(target, true);
        s.openTab({ kind: "request", id: created.item.id });
        toast.success("Request imported");
      } else {
        const res = await api.importText(text, fileName);
        if (res.kind === "collection") {
          s.applyWorkspace(res.workspace);
          ui.setSection("collections");
          ui.toggle(res.collectionId, true);
          s.openTab({ kind: "collection", id: res.collectionId });
          toast.success("Collection imported");
        } else if (res.kind === "environment") {
          s.applyWorkspace(res.workspace);
          ui.setSection("environments");
          s.openTab({ kind: "environment", id: res.environmentId });
          toast.success("Environment imported");
        }
      }
      onClose();
    } catch (err) {
      toast.error("Import failed", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import"
      subtitle="Paste a cURL command, an OpenAPI or Swagger document (JSON or YAML), or a v2.1 collection or environment JSON export."
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button variant="cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!format || format === "unknown" || busy} onClick={() => void submit()}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-13 text-grey">
          {format ? (
            <>
              Detected: <b className={format === "unknown" ? "font-medium text-danger" : "font-medium text-primary"}>{FORMAT_LABEL[format]}</b>
            </>
          ) : (
            "Paste below, or choose a file."
          )}
        </span>
        <input
          ref={input}
          type="file"
          accept=".json,.yaml,.yml,.txt,.sh"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFileName(f.name);
            setText(await f.text());
          }}
        />
        <Button variant="cancel" size="sm" icon={FileUp} onClick={() => input.current?.click()}>
          Choose file
        </Button>
      </div>
      <div className="h-72 overflow-hidden rounded-lg border border-line">
        <CodeEditor fill value={text} onChange={setText} language={text.trimStart().startsWith("{") ? "json" : "text"} placeholder={"curl https://api.example.com/users -H 'Accept: application/json'"} ariaLabel="Import content" />
      </div>
      {format === "curl" && (
        <div className="mt-4">
          <label className="label" htmlFor="import-target">
            Add the request to
          </label>
          <select id="import-target" className="input max-w-sm" value={target} onChange={(e) => setTarget(e.target.value)}>
            {(collections ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </Modal>
  );
}
