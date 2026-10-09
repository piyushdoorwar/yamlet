import type { Variable } from "@core/models";
import { CircleCheck, Globe, SlidersHorizontal } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { Button } from "../components/Button";
import { KeyValueTable } from "../components/KeyValueTable";
import { Card, PageHeader, SaveStatus, ScrollPage } from "../components/Page";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { useAutosave } from "../lib/useAutosave";
import type { VariableTarget } from "../editor/CodeEditor";
import { upsertVariable, useVariableSource } from "../lib/variables";

const blankVar = (): Variable => ({ key: "", value: "", enabled: true });
const NONE: Variable[] = [];

/** `name` is the environment on screen; omitted for the globals page. */
function VariablesCard({ name, variables, onChange, note }: { name?: string; variables: Variable[]; onChange: (v: Variable[]) => void; note: string }) {
  const globals = useStore((s) => s.workspace?.globals);
  const latest = useRef({ variables, onChange });
  latest.current = { variables, onChange };
  // Peek writes go to the page's own unsaved copy, not to the active environment.
  const write = useCallback((key: string, value: string) => latest.current.onChange(upsertVariable(latest.current.variables, key, value)), []);
  const targets = useMemo<VariableTarget[]>(
    () => [name !== undefined ? { scope: "environment", label: `Environment: ${name}`, write } : { scope: "globals", label: "Globals", write }],
    [name, write],
  );
  const ctx = useMemo(() => (name !== undefined ? { environment: variables, globals } : { globals: variables }), [name, variables, globals]);
  const source = useVariableSource(ctx, targets);
  return (
    <Card title={`Variables (${variables.length})`} actions={<span className="text-12 text-muted">{note}</span>}>
      <KeyValueTable<Variable> rows={variables} onChange={onChange} blank={blankVar} variables={source} keyPlaceholder="Variable" secrets />
      <p className="mt-3 text-12 text-muted">Secret values are masked on screen but still stored in the YAML file. Keep real secrets out of Git, for example with a gitignored environment file.</p>
    </Card>
  );
}

export function EnvironmentView({ environmentId }: { environmentId: string }) {
  const env = useStore((s) => s.workspace?.environments.find((e) => e.id === environmentId));
  const isActive = useStore((s) => s.environmentId === environmentId);
  const setEnvironment = useStore((s) => s.setEnvironment);
  const applyWorkspace = useStore((s) => s.applyWorkspace);
  const { value, update, status, error, retry } = useAutosave(env?.variables ?? NONE, async (variables) => {
    if (!env) return;
    const res = await api.saveEnvironment({ ...env, variables });
    applyWorkspace(res.workspace);
  });
  if (!env) return <p className="p-8 text-13 text-muted">This environment no longer exists.</p>;
  return (
    <ScrollPage>
      <PageHeader
        icon={<SlidersHorizontal size={20} aria-hidden />}
        title={env.name}
        subtitle={env.filePath}
        actions={
          <>
            <SaveStatus status={status} error={error} onRetry={retry} />
            {isActive ? (
              <span className="flex items-center gap-1.5 rounded-md bg-primary-soft px-3 py-2 text-13 font-medium text-primary">
                <CircleCheck size={14} aria-hidden /> Active environment
              </span>
            ) : (
              <Button onClick={() => setEnvironment(env.id)}>Set active</Button>
            )}
          </>
        }
      />
      <VariablesCard name={env.name} variables={value} onChange={update} note="Override globals; overridden by collection and request variables." />
    </ScrollPage>
  );
}

export function GlobalsView() {
  const globals = useStore((s) => s.workspace?.globals);
  const path = useStore((s) => s.workspace?.globalsPath);
  const applyWorkspace = useStore((s) => s.applyWorkspace);
  const { value, update, status, error, retry } = useAutosave(globals ?? NONE, async (variables) => {
    const res = await api.saveGlobals(variables);
    applyWorkspace(res.workspace);
  });
  return (
    <ScrollPage>
      <PageHeader icon={<Globe size={20} aria-hidden />} title="Globals" subtitle={path} actions={<SaveStatus status={status} error={error} onRetry={retry} />} />
      <VariablesCard variables={value} onChange={update} note="Lowest precedence; visible to every request in the workspace." />
    </ScrollPage>
  );
}
