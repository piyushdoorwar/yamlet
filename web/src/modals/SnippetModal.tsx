import { generateSnippet, SNIPPET_LANGUAGES } from "@core/codegen";
import { buildRequest } from "@core/requestBuilder";
import { Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { CodeEditor, type EditorLanguage } from "../editor/CodeEditor";
import { copyText } from "../lib/format";
import { readJson, writeJson } from "../lib/storage";
import { useStore } from "../lib/store";
import { findRequest } from "../lib/tree";
import { useVariableContext } from "../lib/variables";

const LANG_EDITOR: Record<string, EditorLanguage> = {
  "javascript-fetch": "javascript",
  "node-axios": "javascript",
};

export function SnippetModal({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const draft = useStore((s) => s.drafts[requestId]);
  const loc = useMemo(() => findRequest(workspace, requestId), [workspace, requestId]);
  const request = draft ?? loc?.request;
  const ctx = useVariableContext(loc?.collection.id, request?.variables);
  const [lang, setLang] = useState<string>(() => readJson("yamlet.snippetLang", "curl"));
  const [resolve, setResolve] = useState(true);
  const toast = useToast();

  const code = useMemo(() => {
    if (!request) return "";
    try {
      const built = buildRequest(request, { ctx: resolve ? ctx : {}, collection: loc?.collection });
      return generateSnippet(lang, built);
    } catch (err) {
      return `// Could not generate this snippet: ${(err as Error).message}`;
    }
  }, [request, ctx, lang, resolve, loc]);

  return (
    <Modal
      title="Code snippet"
      subtitle={request ? `${request.method} ${request.name}` : undefined}
      onClose={onClose}
      width={820}
      footer={
        <Button icon={Copy} onClick={async () => (await copyText(code)) && toast.success("Snippet copied")}>
          Copy
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <select
          className="input w-60"
          aria-label="Language"
          value={lang}
          onChange={(e) => {
            setLang(e.target.value);
            writeJson("yamlet.snippetLang", e.target.value);
          }}
        >
          {SNIPPET_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-13 text-body">
          <input type="checkbox" className="check" checked={resolve} onChange={(e) => setResolve(e.target.checked)} /> Resolve variables
        </label>
      </div>
      <div className="h-96 overflow-hidden rounded-lg border border-line">
        <CodeEditor fill readOnly value={code} language={LANG_EDITOR[lang] ?? "text"} ariaLabel="Snippet" />
      </div>
    </Modal>
  );
}
