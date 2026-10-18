// GraphQL editing: syntax, schema-aware completion and validation. Loaded on demand
// (the graphql package is large), so only GraphQL bodies pay for it.
import type { YamletRequest } from "@core/models";
import { graphql } from "cm6-graphql";
import { buildClientSchema, getIntrospectionQuery, type GraphQLSchema, type IntrospectionQuery } from "graphql";
import { api } from "../lib/api";

export type { GraphQLSchema };

export const graphqlExtension = (schema?: GraphQLSchema) => graphql(schema);

/** Schemas fetched this session, by request id, so switching tabs keeps completion. */
const schemas = new Map<string, GraphQLSchema>();

export const cachedSchema = (requestId: string) => schemas.get(requestId);

/**
 * Runs the introspection query against the request's URL with its headers and auth.
 * The request's own scripts are left out so fetching a schema changes nothing.
 */
export async function fetchSchema(request: YamletRequest, collectionId: string | undefined, environmentId: string | null): Promise<GraphQLSchema> {
  const probe: YamletRequest = {
    ...request,
    method: "POST",
    body: { ...request.body, type: "graphql", graphqlQuery: getIntrospectionQuery(), graphqlVariables: "" },
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
