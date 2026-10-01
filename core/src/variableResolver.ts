// {{placeholder}} resolution. Isomorphic: the browser uses it for highlighting.
import type { Variable } from "./models.js";
import { tryGenerate } from "./dynamicVariables.js";

/**
 * The scopes available when resolving a request. Precedence, highest first:
 * request, iteration data, collection, environment, globals. Keys match case-insensitively.
 */
export interface VariableContext {
  request?: Variable[];
  collection?: Variable[];
  environment?: Variable[];
  globals?: Variable[];
  iterationData?: Record<string, string>;
}

export type VariableScope = "request" | "data" | "collection" | "environment" | "globals" | "dynamic";

export interface VariableLookup {
  value: string;
  scope: VariableScope;
}

export interface Placeholder {
  /** The trimmed placeholder body, e.g. `baseUrl` or `$guid`. */
  name: string;
  /** Offset of the opening `{{`. */
  start: number;
  /** Offset just past the closing `}}`. */
  end: number;
}

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

type Layer = { scope: Exclude<VariableScope, "dynamic">; values: Map<string, string> };

function layerFromVariables(scope: Layer["scope"], vars: Variable[] | undefined): Layer | undefined {
  if (!vars?.length) return undefined;
  const values = new Map<string, string>();
  for (const v of vars) {
    // Later entries win within a layer.
    if (v && v.enabled !== false && v.key) values.set(v.key.toLowerCase(), v.value ?? "");
  }
  return { scope, values };
}

function layers(ctx: VariableContext): Layer[] {
  const data = ctx.iterationData
    ? {
        scope: "data" as const,
        values: new Map(Object.entries(ctx.iterationData).map(([k, v]) => [k.toLowerCase(), v == null ? "" : String(v)])),
      }
    : undefined;
  return [
    layerFromVariables("request", ctx.request),
    data,
    layerFromVariables("collection", ctx.collection),
    layerFromVariables("environment", ctx.environment),
    layerFromVariables("globals", ctx.globals),
  ].filter((l): l is Layer => !!l);
}

function lookupIn(ls: Layer[], name: string): VariableLookup | undefined {
  const key = name.toLowerCase();
  for (const l of ls) {
    const v = l.values.get(key);
    if (v !== undefined) return { value: v, scope: l.scope };
  }
  return undefined;
}

/** Finds a user variable (or, failing that, a dynamic variable sample) for `name`. */
export function lookupVariable(name: string, ctx: VariableContext): VariableLookup | undefined {
  const found = lookupIn(layers(ctx), name.trim());
  if (found) return found;
  const generated = tryGenerate(name);
  return generated === undefined ? undefined : { value: generated, scope: "dynamic" };
}

/** Flattened view of all user variables with precedence applied; keys keep their original casing. */
export function mergedVariables(ctx: VariableContext): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const add = (k: string, v: string) => {
    const lk = k.toLowerCase();
    if (seen.has(lk)) return;
    seen.add(lk);
    out[k] = v;
  };
  const addVars = (vars?: Variable[]) => {
    if (!vars) return;
    for (let i = vars.length - 1; i >= 0; i--) {
      const v = vars[i];
      if (v && v.enabled !== false && v.key) add(v.key, v.value ?? "");
    }
  };
  addVars(ctx.request);
  if (ctx.iterationData) for (const [k, v] of Object.entries(ctx.iterationData)) add(k, v == null ? "" : String(v));
  addVars(ctx.collection);
  addVars(ctx.environment);
  addVars(ctx.globals);
  return out;
}

/**
 * Replaces `{{name}}` placeholders. Unknown placeholders are left untouched so missing
 * variables stay visible. User variables win over dynamic ones; each dynamic occurrence
 * generates a fresh value. Single pass (no recursive expansion).
 */
export function resolveVariables(text: string | undefined | null, ctx: VariableContext): string {
  if (!text) return text ?? "";
  if (!text.includes("{{")) return text;
  const ls = layers(ctx);
  return text.replace(PLACEHOLDER, (match, name: string) => {
    const found = lookupIn(ls, name);
    if (found) return found.value;
    return tryGenerate(name) ?? match;
  });
}

export function findPlaceholders(text: string | undefined | null): Placeholder[] {
  if (!text) return [];
  const out: Placeholder[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    out.push({ name: m[1], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}
