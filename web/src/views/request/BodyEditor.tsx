import type { BodyField, BodyType, RequestBody, YamletRequest } from "@core/models";
import type { Extension } from "@codemirror/state";
import clsx from "clsx";
import { Check, CircleAlert, LoaderCircle, RefreshCw, Wand2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { FileChooser } from "../../components/FileChooser";
import { KeyValueTable } from "../../components/KeyValueTable";
import { useToast } from "../../components/Toast";
import { CodeEditor, type EditorLanguage, type VariableSource } from "../../editor/CodeEditor";
import { prettyXml } from "../../lib/format";
import { useStore } from "../../lib/store";

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
  { id: "javascript", label: "JavaScript", lang: "javascript" },
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

/** Why `text` isn't JSON, with {{variables}} counted as values; undefined when it's fine or empty. */
function jsonProblem(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    JSON.parse(text.replace(/\{\{[^{}]*\}\}/g, "0"));
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type SchemaState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; types: number } | { kind: "error"; message: string };

/** The GraphQL query editor: highlighting always, completion and checks once a schema is fetched. */
function GraphQlQuery({ value, onChange, variables, request, collectionId }: { value: string; onChange: (v: string) => void; variables: VariableSource; request?: YamletRequest; collectionId?: string }) {
  const environmentId = useStore((s) => s.environmentId);
  const [mode, setMode] = useState<typeof import("../../editor/graphqlMode") | null>(null);
  const [ext, setExt] = useState<Extension | undefined>(undefined);
  const [schema, setSchema] = useState<SchemaState>({ kind: "idle" });

  useEffect(() => {
    let live = true;
    void import("../../editor/graphqlMode").then((m) => {
      if (!live) return;
      setMode(m);
      const cached = request ? m.cachedSchema(request.id) : undefined;
      setExt(m.graphqlExtension(cached));
      setSchema(cached ? { kind: "ready", types: Object.keys(cached.getTypeMap()).length } : { kind: "idle" });
    });
    return () => {
      live = false;
    };
  }, [request?.id]);

  const fetchSchema = async () => {
    if (!mode || !request) return;
    setSchema({ kind: "loading" });
    try {
      const s = await mode.fetchSchema(request, collectionId, environmentId);
      setExt(mode.graphqlExtension(s));
      setSchema({ kind: "ready", types: Object.keys(s.getTypeMap()).length });
    } catch (err) {
      setSchema({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-1.5 flex min-h-6 items-center gap-2">
        <span className="text-12 font-medium text-grey">Query</span>
        {request && (
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {schema.kind === "ready" && (
              <span className="flex items-center gap-1 text-11 text-muted">
                <Check size={12} className="text-primary" aria-hidden />
                Schema loaded ({schema.types} types)
              </span>
            )}
            {schema.kind === "error" && (
              <span className="flex min-w-0 items-center gap-1 text-11 text-danger" title={schema.message} role="alert">
                <CircleAlert size={12} className="shrink-0" aria-hidden />
                <span className="truncate">{schema.message}</span>
              </span>
            )}
            <button type="button" className="btn btn-ghost btn-sm shrink-0" disabled={!mode || schema.kind === "loading" || !request.url.trim()} onClick={() => void fetchSchema()} title="Run an introspection query against this URL, with this request's headers and auth">
              {schema.kind === "loading" ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}
              {schema.kind === "ready" ? "Refresh schema" : "Fetch schema"}
            </button>
          </div>
        )}
      </div>
      <div className="min-h-40 flex-1 overflow-hidden rounded-lg border border-line">
        <CodeEditor fill value={value} onChange={onChange} variables={variables} extensions={ext} placeholder={"query {\n  viewer { id }\n}"} ariaLabel="GraphQL query" />
      </div>
    </div>
  );
}

export function BodyEditor({
  body,
  onChange,
  variables,
  request,
  collectionId,
}: {
  body: RequestBody;
  onChange: (b: RequestBody) => void;
  variables: VariableSource;
  /** The request this body belongs to; lets the GraphQL editor fetch the schema. */
  request?: YamletRequest;
  collectionId?: string;
}) {
  const toast = useToast();
  const radioName = useId();
  const partTypesId = useId();
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
          <datalist id={partTypesId}>
            {["application/json", "text/plain", "application/xml", "text/csv", "application/octet-stream", "image/png", "image/jpeg", "application/pdf"].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
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
            afterValueLabel="Content-Type"
            renderAfterValue={(row, update) => (
              <input
                className="kv-cell font-mono text-12"
                list={partTypesId}
                value={row.contentType ?? ""}
                placeholder={row.isFile ? "From file name" : "None"}
                aria-label="Part Content-Type"
                onChange={(e) => update({ contentType: e.target.value || undefined })}
              />
            )}
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
          <GraphQlQuery value={body.graphqlQuery} onChange={(v) => set({ graphqlQuery: v })} variables={variables} request={request} collectionId={collectionId} />
          <div className="flex min-h-0 flex-col">
            <div className="mb-1.5 flex min-h-6 items-center gap-2">
              <span className="text-12 font-medium text-grey">Variables (JSON)</span>
              {jsonProblem(body.graphqlVariables) && (
                <span className="flex min-w-0 items-center gap-1 text-11 text-danger" title={jsonProblem(body.graphqlVariables)}>
                  <CircleAlert size={12} className="shrink-0" aria-hidden />
                  <span className="truncate">Not valid JSON; the request won't send</span>
                </span>
              )}
            </div>
            <div className="min-h-40 flex-1 overflow-hidden rounded-lg border border-line">
              <CodeEditor fill language="json" value={body.graphqlVariables} onChange={(v) => set({ graphqlVariables: v })} variables={variables} placeholder="{}" ariaLabel="GraphQL variables" />
            </div>
          </div>
        </div>
      )}

      {body.type === "binary" && (
        <div className={clsx("rounded-lg border border-line bg-surface py-4")}>
          <FileChooser value={body.binaryFile} onChange={(binaryFile) => set({ binaryFile })} />
          <p className="mt-2 px-4 text-11 text-muted">The file's bytes are sent as the request body. Set a Content-Type header if the server needs one.</p>
        </div>
      )}
    </div>
  );
}
