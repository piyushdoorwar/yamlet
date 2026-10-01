import type { Variable } from "@core/models";
import { lookupVariable, type VariableContext } from "@core/variableResolver";
import { useMemo } from "react";
import type { VariableSource } from "../editor/CodeEditor";
import { api } from "./api";
import { useStore } from "./store";

/** Scopes visible to a request (or a collection, when requestVariables is omitted). */
export function useVariableContext(collectionId: string | undefined, requestVariables?: Variable[]): VariableContext {
  const workspace = useStore((s) => s.workspace);
  const environmentId = useStore((s) => s.environmentId);
  return useMemo(() => {
    const collection = workspace?.collections.find((c) => c.id === collectionId);
    const env = workspace?.environments.find((e) => e.id === environmentId);
    return {
      request: requestVariables,
      collection: collection?.variables,
      environment: env?.variables,
      globals: workspace?.globals,
    };
  }, [workspace, environmentId, collectionId, requestVariables]);
}

/** Write a variable to the active environment (hover-peek "Set"). */
export async function setEnvironmentVariable(name: string, value: string): Promise<void> {
  const { workspace, environmentId, applyWorkspace } = useStore.getState();
  const env = workspace?.environments.find((e) => e.id === environmentId);
  if (!env) return;
  const exists = env.variables.some((v) => v.key === name);
  const variables = exists
    ? env.variables.map((v) => (v.key === name ? { ...v, value, enabled: true } : v))
    : [...env.variables, { key: name, value, enabled: true }];
  const res = await api.saveEnvironment({ ...env, variables });
  applyWorkspace(res.workspace);
}

export function useVariableSource(ctx: VariableContext): VariableSource {
  const hasEnv = useStore((s) => !!s.environmentId);
  return useMemo(() => {
    const scopes: [string, Variable[] | undefined][] = [
      ["request", ctx.request],
      ["collection", ctx.collection],
      ["environment", ctx.environment],
      ["globals", ctx.globals],
    ];
    const version = JSON.stringify(scopes.map(([n, vars]) => [n, (vars ?? []).filter((v) => v.enabled).map((v) => [v.key, v.value])])) + String(hasEnv);
    return {
      version,
      lookup: (name) => {
        if (name.startsWith("$")) return undefined;
        const hit = lookupVariable(name, ctx);
        return hit && hit.scope !== "dynamic" ? { value: hit.value, scope: hit.scope } : undefined;
      },
      names: () => {
        const seen = new Set<string>();
        const out: { name: string; scope: string; value: string }[] = [];
        for (const [scope, vars] of scopes) {
          for (const v of vars ?? []) {
            if (!v.enabled || !v.key || seen.has(v.key)) continue;
            seen.add(v.key);
            out.push({ name: v.key, scope, value: v.secret ? "••••••" : v.value });
          }
        }
        return out;
      },
      edit: hasEnv ? (name, value) => void setEnvironmentVariable(name, value) : undefined,
    };
  }, [ctx, hasEnv]);
}
