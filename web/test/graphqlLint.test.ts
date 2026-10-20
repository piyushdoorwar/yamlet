import { buildSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { lintGraphQl } from "../src/editor/graphqlMode";

const schema = buildSchema("type Query { user(id: ID!, name: String): User }\ntype User { id: ID! name: String }");

describe("lintGraphQl", () => {
  it("accepts {{variable}} placeholders where values go", () => {
    expect(lintGraphQl("query { user(id: {{userId}}) { id } }", schema)).toEqual([]);
    expect(lintGraphQl('query { user(id: 1, name: {{who}}) { name } }', schema)).toEqual([]);
  });

  it("still reports real problems", () => {
    const doc = "query { user(id: {{userId}}) { nope } }";
    const [d] = lintGraphQl(doc, schema);
    expect(d.message).toMatch(/nope/);
    expect(doc.slice(d.from, d.to)).toBe("nope");
  });
});
