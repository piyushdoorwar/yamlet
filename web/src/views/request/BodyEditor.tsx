import type { BodyField, BodyType, RequestBody } from "@core/models";
import clsx from "clsx";
import { Wand2 } from "lucide-react";
import { useId } from "react";
import { FileChooser } from "../../components/FileChooser";
import { KeyValueTable } from "../../components/KeyValueTable";
import { useToast } from "../../components/Toast";
import { CodeEditor, type EditorLanguage, type VariableSource } from "../../editor/CodeEditor";
import { prettyXml } from "../../lib/format";

const KINDS: { id: string; label: string }[] = [
  { id: "none", label: "none" },
  { id: "form-data", label: "form-data" },
  { id: "urlencoded", label: "x-www-form-urlencoded" },
  { id: "raw", label: "raw" },
  { id: "graphql", label: "GraphQL" },
  { id: "binary", label: "binary" },
];

const RAW_TYPES: { id: BodyType; label: string; lang: EditorLanguage }[] = [
  { id: "json", label: "JSON", lang: "json" },
  { id: "text", label: "Text", lang: "text" },
  { id: "xml", label: "XML", lang: "xml" },
  { id: "html", label: "HTML", lang: "html" },
  { id: "raw", label: "Raw", lang: "text" },
];

const isRaw = (t: BodyType) => RAW_TYPES.some((r) => r.id === t);
const blankField = (): BodyField => ({ key: "", value: "", enabled: true });

/**
 * Format text that may contain {{placeholders}}: each one is swapped for a token
 * that keeps the JSON valid, then put back. Tokens are quoted when the placeholder
 * stands alone as a value and bare when it sits inside a string.
 */
/** Throws when the masked text isn't valid. */
function formatWithPlaceholders(text: string, format: (t: string) => string): string {
  const stash: string[] = [];
  let inString = false;
  let masked = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" && text[i + 1] === "{") {
      const close = text.indexOf("}}", i + 2);
      if (close > 0) {
        stash.push(text.slice(i, close + 2));
        const token = `__yamlet_${stash.length - 1}__`;
        masked += inString ? token : `"${token}"`;
        i = close + 1;
        continue;
      }
    }
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    masked += ch;
  }
  const out = format(masked);
  return out.replace(/"__yamlet_(\d+)__"|__yamlet_(\d+)__/g, (_, a, b) => stash[Number(a ?? b)]);
}

export function BodyEditor({ body, onChange, variables }: { body: RequestBody; onChange: (b: RequestBody) => void; variables: VariableSource }) {
  const toast = useToast();
  const radioName = useId();
  const kind = isRaw(body.type) ? "raw" : body.type;
  const set = (patch: Partial<RequestBody>) => onChange({ ...body, ...patch });
  const raw = RAW_TYPES.find((r) => r.id === body.type);

  const beautify = () => {
    if (body.type === "json") {
      try {
        set({ raw: formatWithPlaceholders(body.raw, (t) => JSON.stringify(JSON.parse(t), null, 2)) });
      } catch (err) {
        toast.error("Not valid JSON", (err as Error).message);
      }
    } else if (body.type === "xml" || body.type === "html") {
      set({ raw: prettyXml(body.raw) });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3">
        <div role="radiogroup" aria-label="Body type" className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {KINDS.map((k) => (
            <label key={k.id} className="flex cursor-pointer items-center gap-1.5 text-13 text-body">
              <input
                type="radio"
                name={radioName}
                className="accent-[var(--color-primary)]"
                checked={kind === k.id}
                onChange={() => set({ type: k.id === "raw" ? (isRaw(body.type) ? body.type : "json") : (k.id as BodyType) })}
              />
              {k.label}
            </label>
          ))}
        </div>
        {kind === "raw" && (
          <>
            <select className="input h-7 w-24 text-12" aria-label="Raw format" value={body.type} onChange={(e) => set({ type: e.target.value as BodyType })}>
              {RAW_TYPES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            {(body.type === "json" || body.type === "xml" || body.type === "html") && (
              <button type="button" className="ml-auto flex items-center gap-1.5 text-12 font-medium text-primary hover:underline" onClick={beautify}>
                <Wand2 size={13} aria-hidden /> Beautify
              </button>
            )}
          </>
        )}
      </div>

      {body.type === "none" && <p className="py-6 text-center text-13 text-muted">This request does not have a body.</p>}

      {raw && (
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-line">
          <CodeEditor fill value={body.raw} onChange={(v) => set({ raw: v })} language={raw.lang} variables={variables} ariaLabel="Request body" />
        </div>
      )}

      {body.type === "form-data" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <KeyValueTable<BodyField>
            rows={body.fields}
            onChange={(fields) => set({ fields })}
            blank={blankField}
            variables={variables}
            showDescription
            renderExtra={(row, update) => (
              <select
                className="h-7 w-full rounded border-none bg-transparent text-12 text-grey outline-none"
                aria-label="Field type"
                value={row.isFile ? "file" : "text"}
                onChange={(e) => update({ isFile: e.target.value === "file", value: "" })}
              >
                <option value="text">Text</option>
                <option value="file">File</option>
              </select>
            )}
            renderValue={(row, update) => (row.isFile ? <FileChooser compact value={row.value} onChange={(value) => update({ value })} /> : undefined)}
          />
        </div>
      )}

      {body.type === "urlencoded" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <KeyValueTable<BodyField> rows={body.fields} onChange={(fields) => set({ fields })} blank={blankField} variables={variables} showDescription />
        </div>
      )}

      {body.type === "graphql" && (
        <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[3fr_2fr]">
          <div className="flex min-h-0 flex-col">
            <span className="mb-1.5 text-12 font-medium text-grey">Query</span>
            <div className="min-h-40 flex-1 overflow-hidden rounded-lg border border-line">
              <CodeEditor fill value={body.graphqlQuery} onChange={(v) => set({ graphqlQuery: v })} variables={variables} placeholder={"query {\n  viewer { id }\n}"} ariaLabel="GraphQL query" />
            </div>
          </div>
          <div className="flex min-h-0 flex-col">
            <span className="mb-1.5 text-12 font-medium text-grey">Variables (JSON)</span>
            <div className="min-h-40 flex-1 overflow-hidden rounded-lg border border-line">
              <CodeEditor fill language="json" value={body.graphqlVariables} onChange={(v) => set({ graphqlVariables: v })} variables={variables} placeholder="{}" ariaLabel="GraphQL variables" />
            </div>
          </div>
        </div>
      )}

      {body.type === "binary" && (
        <div className={clsx("rounded-lg border border-line bg-white py-4")}>
          <FileChooser value={body.binaryFile} onChange={(binaryFile) => set({ binaryFile })} />
          <p className="mt-2 px-4 text-11 text-muted">The file's bytes are sent as the request body. Set a Content-Type header if the server needs one.</p>
        </div>
      )}
    </div>
  );
}
