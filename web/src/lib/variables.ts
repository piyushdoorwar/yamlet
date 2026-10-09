import { scopeIsLocal, type Variable } from "@core/models";
import type { VariableContext } from "@core/variableResolver";
import { useMemo } from "react";
import type { VariableSource, VariableTarget } from "../editor/CodeEditor";
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

/**
 * Sets `name` in a variable list: updates (and enables) an existing entry, matching the
 * key case-insensitively like the resolver does, or appends a new one.
 */
export function upsertVariable(vars: Variable[], name: string, value: string): Variable[] {
  const idx = vars.findIndex((v) => v.key === name);
  const at = idx >= 0 ? idx : vars.findIndex((v) => v.key.toLowerCase() === name.toLowerCase());
  if (at < 0) return [...vars, { key: name, value, enabled: true, ...(scopeIsLocal(vars) ? { local: true } : {}) }];
  return vars.map((v, i) => (i === at ? { ...v, value, enabled: true } : v));
}

/** Write a variable to the active environment. */
export async function setEnvironmentVariable(name: string, value: string): Promise<void> {
  const { workspace, environmentId, applyWorkspace } = useStore.getState();
  const env = workspace?.environments.find((e) => e.id === environmentId);
  if (!env) throw new Error("No environment is selected");
  const res = await api.saveEnvironment({ ...env, variables: upsertVariable(env.variables, name, value) });
  applyWorkspace(res.workspace);
}

async function setCollectionVariable(collectionId: string, name: string, value: string): Promise<void> {
  const { workspace, applyWorkspace } = useStore.getState();
  const collection = workspace?.collections.find((c) => c.id === collectionId);
  if (!collection) throw new Error("The collection no longer exists");
  const res = await api.updateCollection(collectionId, { variables: upsertVariable(collection.variables, name, value) });
  applyWorkspace(res.workspace);
}

async function setGlobalVariable(name: string, value: string): Promise<void> {
  const { workspace, applyWorkspace } = useStore.getState();
  const res = await api.saveGlobals(upsertVariable(workspace?.globals ?? [], name, value));
  applyWorkspace(res.workspace);
}

type Writer = (name: string, value: string) => Promise<void> | void;

/**
 * Where the hover peek can write variables, highest precedence first. Collection,
 * active environment and globals write through the API; a view that holds an unsaved
 * copy of a scope passes its own writer so the edit lands in that copy instead.
 */
export function useVariableTargets(opts: { collectionId?: string; request?: Writer; collection?: Writer; environment?: { label: string; write: Writer } } = {}): VariableTarget[] {
  const environmentId = useStore((s) => s.environmentId);
  const envName = useStore((s) => s.workspace?.environments.find((e) => e.id === s.environmentId)?.name);
  const collectionName = useStore((s) => s.workspace?.collections.find((c) => c.id === opts.collectionId)?.name);
  const { collectionId, request, collection, environment } = opts;
  return useMemo(() => {
    const out: VariableTarget[] = [];
    if (request) out.push({ scope: "request", label: "This request", write: request });
    if (collection) out.push({ scope: "collection", label: "Collection", write: collection });
    else if (collectionId && collectionName) out.push({ scope: "collection", label: `Collection: ${collectionName}`, write: (n, v) => setCollectionVariable(collectionId, n, v) });
    if (environment) out.push({ scope: "environment", label: environment.label, write: environment.write });
    else if (environmentId && envName) out.push({ scope: "environment", label: `Environment: ${envName}`, write: setEnvironmentVariable });
    out.push({ scope: "globals", label: "Globals", write: setGlobalVariable });
    return out;
  }, [request, collection, collectionId, collectionName, environment, environmentId, envName]);
}

const SCOPES = ["request", "collection", "environment", "globals"] as const;

export function useVariableSource(ctx: VariableContext, targets?: VariableTarget[]): VariableSource {
  return useMemo(() => {
    const scopes: [string, Variable[] | undefined][] = SCOPES.map((s) => [s, ctx[s]]);
    const version =
      JSON.stringify(scopes.map(([n, vars]) => [n, (vars ?? []).filter((v) => v.enabled).map((v) => [v.key, v.value])])) +
      (targets ?? []).map((t) => t.label).join("|");
    return {
      version,
      targets,
      lookup: (name) => {
        if (name.startsWith("$")) return undefined;
        const key = name.trim().toLowerCase();
        for (const [scope, vars] of scopes) {
          // Later entries win within a scope, as in the resolver.
          const hit = vars?.findLast((v) => v.enabled !== false && v.key && v.key.toLowerCase() === key);
          if (hit) return { value: hit.value ?? "", scope, secret: hit.secret };
        }
        return undefined;
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
    };
  }, [ctx, targets]);
}
