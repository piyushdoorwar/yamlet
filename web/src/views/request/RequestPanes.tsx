import { type KeyValue, type PathVariable, type Variable, yamletUserAgent, type YamletCollection, type YamletRequest } from "@core/models";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { AuthEditor } from "../../components/AuthEditor";
import { KeyValueTable } from "../../components/KeyValueTable";
import { StatusPill } from "../../components/Labels";
import { CountBadge, Dot, UnderlineTabs } from "../../components/Tabs";
import { CodeEditor, type VariableSource } from "../../editor/CodeEditor";
import { BodyEditor } from "./BodyEditor";
import { ScriptsEditor } from "./ScriptsEditor";
import { SettingsPane } from "./SettingsPane";

type PaneId = "params" | "auth" | "headers" | "body" | "scripts" | "vars" | "settings" | "docs" | "examples";

const blankKv = (): KeyValue => ({ key: "", value: "", enabled: true });
const blankVar = (): Variable => ({ key: "", value: "", enabled: true });

const AUTH_LABEL: Record<string, string> = {
  none: "No auth",
  bearer: "Bearer token",
  basic: "Basic auth",
  apikey: "API key",
  cookie: "Cookie",
  oauth2: "OAuth 2.0",
};

interface Props {
  request: YamletRequest;
  collection?: YamletCollection;
  update: (fn: (r: YamletRequest) => YamletRequest) => void;
  variables: VariableSource;
}

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-12 font-medium text-grey">
        {title}
        {hint && <span className="ml-2 font-normal text-muted">{hint}</span>}
      </h3>
      {children}
    </section>
  );
}

export function RequestPanes({ request, collection, update, variables }: Props) {
  const [pane, setPane] = useState<PaneId>(request.body.type !== "none" && request.method !== "GET" ? "body" : "params");
  const set = (patch: Partial<YamletRequest>) => update((r) => ({ ...r, ...patch }));

  const enabledHeaders = request.headers.filter((h) => h.enabled && h.key).length;
  const enabledParams = request.queryParams.filter((p) => p.enabled && p.key).length;
  const hasScripts = !!(request.preRequestScript.trim() || request.postResponseScript.trim());
  const hasAuth = request.auth.type !== "inherit" && request.auth.type !== "none";
  const count = (n: number) => (n ? String(n) : undefined);

  const tabs = [
    { id: "params" as const, label: "Params", badge: <CountBadge n={enabledParams + request.pathVariables.length} />, hint: count(enabledParams + request.pathVariables.length) },
    { id: "auth" as const, label: "Authorization", badge: hasAuth ? <Dot /> : null, hint: hasAuth ? "set" : undefined },
    { id: "headers" as const, label: "Headers", badge: <CountBadge n={enabledHeaders} />, hint: count(enabledHeaders) },
    { id: "body" as const, label: "Body", badge: request.body.type !== "none" ? <Dot /> : null, hint: request.body.type !== "none" ? "set" : undefined },
    { id: "scripts" as const, label: "Scripts", badge: hasScripts ? <Dot /> : null, hint: hasScripts ? "set" : undefined },
    { id: "vars" as const, label: "Variables", badge: <CountBadge n={request.variables.length} />, hint: count(request.variables.length) },
    { id: "settings" as const, label: "Settings" },
    { id: "docs" as const, label: "Docs", badge: request.description.trim() ? <Dot /> : null, hint: request.description.trim() ? "set" : undefined },
    ...(request.examples.length ? [{ id: "examples" as const, label: "Examples", badge: <CountBadge n={request.examples.length} />, hint: count(request.examples.length) }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-5">
        <UnderlineTabs tabs={tabs} active={pane} onChange={setPane} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-4 pb-5">
        {pane === "params" && (
          <>
            <Section title="Query parameters">
              <KeyValueTable<KeyValue>
                rows={request.queryParams}
                blank={blankKv}
                variables={variables}
                showDescription
                onChange={(queryParams) => set({ queryParams })}
              />
            </Section>
            {request.pathVariables.length > 0 && (
              <Section title="Path variables" hint="from :name segments in the URL">
                <KeyValueTable<PathVariable>
                  rows={request.pathVariables}
                  blank={() => ({ key: "", value: "" })}
                  variables={variables}
                  showDescription
                  noToggle
                  fixedKeys
                  onChange={(pathVariables) => set({ pathVariables })}
                />
              </Section>
            )}
          </>
        )}

        {pane === "auth" && (
          <AuthEditor
            auth={request.auth}
            onChange={(auth) => set({ auth })}
            allowInherit
            variables={variables}
            collectionId={collection?.id}
            requestVariables={request.variables}
            inheritedLabel={collection ? AUTH_LABEL[collection.auth.type] : undefined}
          />
        )}

        {pane === "headers" && (
          <KeyValueTable<KeyValue>
            rows={request.headers}
            onChange={(headers) => set({ headers })}
            blank={blankKv}
            variables={variables}
            showDescription
            keyPlaceholder="Header"
            locked={[{ key: "User-Agent", value: yamletUserAgent(), note: "Sent with every request" }]}
          />
        )}

        {pane === "body" && (
          <div className="flex min-h-72 flex-1 flex-col">
            <BodyEditor body={request.body} onChange={(body) => set({ body })} variables={variables} />
          </div>
        )}

        {pane === "scripts" && (
          <div className="flex min-h-72 flex-1 flex-col">
            <ScriptsEditor pre={request.preRequestScript} post={request.postResponseScript} onChange={(p) => set(p)} />
          </div>
        )}

        {pane === "vars" && (
          <Section title="Request variables" hint="highest precedence; only visible to this request">
            <KeyValueTable<Variable> rows={request.variables} onChange={(vars) => set({ variables: vars })} blank={blankVar} variables={variables} keyPlaceholder="Variable" />
          </Section>
        )}

        {pane === "settings" && <SettingsPane settings={request.settings} onChange={(settings) => set({ settings })} />}

        {pane === "docs" && (
          <div className="flex min-h-60 flex-1 flex-col">
            <p className="mb-2 text-12 text-muted">Describe what this request does. Saved in the request's YAML file.</p>
            <div className="min-h-52 flex-1 overflow-hidden rounded-lg border border-line">
              <CodeEditor fill lineNumbers={false} value={request.description} onChange={(description) => set({ description })} placeholder="Notes, expected responses, links…" ariaLabel="Description" />
            </div>
          </div>
        )}

        {pane === "examples" && (
          <ul className="space-y-3">
            {request.examples.map((ex) => (
              <li key={ex.id} className="rounded-lg border border-line bg-white">
                <div className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5">
                  <StatusPill status={ex.status} />
                  <span className="flex-1 truncate text-13 font-medium text-ink">{ex.name}</span>
                  {ex.savedAt && <span className="text-11 text-muted">{new Date(ex.savedAt).toLocaleString()}</span>}
                  <button
                    type="button"
                    aria-label={`Delete example ${ex.name}`}
                    className="rounded p-1 text-muted hover:text-danger"
                    onClick={() => set({ examples: request.examples.filter((e) => e.id !== ex.id) })}
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </div>
                <div className="h-56 overflow-hidden rounded-b-lg">
                  <CodeEditor fill readOnly value={ex.body} language={ex.contentType?.includes("json") ? "json" : "text"} ariaLabel={`Example ${ex.name}`} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
