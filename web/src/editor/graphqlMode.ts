// GraphQL editing: syntax, schema-aware completion and validation. Loaded on demand
// (the graphql package is large), so only GraphQL bodies pay for it.
import type { YamletRequest } from "@core/models";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { completion, getSchema, graphqlLanguageSupport, jump, schemaStateField, stateExtensions } from "cm6-graphql";
import { buildClientSchema, getIntrospectionQuery, type GraphQLSchema, type IntrospectionQuery } from "graphql";
import { getDiagnostics } from "graphql-language-service";
import { api } from "../lib/api";

export type { GraphQLSchema };

const PLACEHOLDER = /\{\{[^{}]*\}\}/g;

/**
 * Schema checks with {{variable}} placeholders allowed: each one is read as a value
 * (`0` padded to its length) and problems on a placeholder itself are dropped, since its
 * real value is only known at send time.
 */
export function lintGraphQl(doc: string, schema: GraphQLSchema): { from: number; to: number; severity: Diagnostic["severity"]; message: string }[] {
  const holes: [number, number][] = [];
  const masked = doc.replace(PLACEHOLDER, (m, at: number) => {
    holes.push([at, at + m.length]);
    return "0".padEnd(m.length, " ");
  });
  const lines = doc.split("\n");
  const offset = (line: number, ch: number) => {
    let at = 0;
    for (let i = 0; i < line && i < lines.length; i++) at += lines[i].length + 1;
    return Math.min(doc.length, at + ch);
  };
  const out: { from: number; to: number; severity: Diagnostic["severity"]; message: string }[] = [];
  let found: ReturnType<typeof getDiagnostics>;
  try {
    found = getDiagnostics(masked, schema);
  } catch {
    return []; // A schema the server described inconsistently: no checks rather than noise.
  }
  for (const d of found) {
    if (!d.severity || !d.source) continue;
    const from = offset(d.range.start.line, d.range.start.character);
    const to = Math.max(from + 1, offset(d.range.end.line, d.range.end.character - 1));
    if (holes.some(([a, b]) => from < b && to > a)) continue;
    out.push({ from, to: Math.min(to, Math.max(doc.length, from + 1)), severity: (["error", "warning", "info"] as const)[d.severity - 1] ?? "error", message: typeof d.message === "string" ? d.message : d.message.value });
  }
  return out;
}

const lint = linter(
  (view) => {
    const schema = getSchema(view.state);
    if (!schema) return [];
    return lintGraphQl(view.state.doc.toString(), schema).map((d) => ({ ...d, to: Math.min(d.to, view.state.doc.length) }));
  },
  { needsRefresh: (u) => u.startState.field(schemaStateField) !== u.state.field(schemaStateField) },
);

export const graphqlExtension = (schema?: GraphQLSchema): Extension[] => [graphqlLanguageSupport(), completion, lint, jump, stateExtensions(schema)];

/** Schemas fetched this session, by request id, so switching tabs keeps completion. */
const schemas = new Map<string, GraphQLSchema>();

export const cachedSchema = (requestId: string) => schemas.get(requestId);

/**
 * Runs the introspection query against the request's URL with its headers and auth.
 * The request's own scripts are left out; collection and folder scripts still run, as for any send.
 */
export async function fetchSchema(request: YamletRequest, collectionId: string | undefined, environmentId: string | null): Promise<GraphQLSchema> {
  const probe: YamletRequest = {
    ...request,
    method: "POST",
    body: { ...request.body, type: "graphql", graphqlQuery: getIntrospectionQuery(), graphqlVariables: "", graphqlOperationName: undefined },
    preRequestScript: "",
    postResponseScript: "",
  };
  const { response } = await api.send({ request: probe, collectionId, environmentId });
  if (response.isError) throw new Error(response.errorMessage || "The request failed.");
  if (response.bodyEncoding !== "utf8") throw new Error(`The server answered ${response.statusCode} with ${response.contentType || "binary data"}, not JSON.`);
  let parsed: { data?: IntrospectionQuery; errors?: { message: string }[] };
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error(`The server answered ${response.statusCode} without JSON; is this a GraphQL endpoint?`);
  }
  if (!parsed.data?.__schema) {
    const why = parsed.errors?.map((e) => e.message).join("; ");
    throw new Error(why ? `Introspection failed: ${why}` : `The server answered ${response.statusCode} without a schema.`);
  }
  const schema = buildClientSchema(parsed.data);
  schemas.set(request.id, schema);
  return schema;
}
