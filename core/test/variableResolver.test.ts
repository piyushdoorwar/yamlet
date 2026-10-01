import { describe, expect, it } from "vitest";
import { DYNAMIC_VARIABLES, findDynamicVariable, isDynamicVariable, tryGenerate } from "../src/dynamicVariables.js";
import type { Variable } from "../src/models.js";
import { findPlaceholders, lookupVariable, mergedVariables, resolveVariables } from "../src/variableResolver.js";

const vars = (...pairs: [string, string][]): Variable[] => pairs.map(([key, value]) => ({ key, value, enabled: true }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("resolveVariables", () => {
  it("replaces a known placeholder", () => {
    expect(resolveVariables("{{baseUrl}}/users", { collection: vars(["baseUrl", "https://api.example.com"]) })).toBe("https://api.example.com/users");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(resolveVariables("{{missing}}/x", {})).toBe("{{missing}}/x");
  });

  it("trims whitespace inside placeholders", () => {
    expect(resolveVariables("{{ token }}", { collection: vars(["token", "abc"]) })).toBe("abc");
  });

  it("applies precedence request > data > collection > environment > globals", () => {
    const ctx = {
      globals: vars(["v", "globals"]),
      environment: vars(["v", "environment"]),
      collection: vars(["v", "collection"]),
      iterationData: { v: "data" },
      request: vars(["v", "request"]),
    };
    expect(resolveVariables("{{v}}", ctx)).toBe("request");
    expect(resolveVariables("{{v}}", { ...ctx, request: undefined })).toBe("data");
    expect(resolveVariables("{{v}}", { ...ctx, request: undefined, iterationData: undefined })).toBe("collection");
    expect(lookupVariable("v", { globals: ctx.globals, environment: ctx.environment })).toEqual({ value: "environment", scope: "environment" });
  });

  it("falls through when higher layers lack the key", () => {
    expect(resolveVariables("{{v}}", { globals: vars(["v", "globals"]), environment: vars(["other", "x"]) })).toBe("globals");
  });

  it("ignores disabled variables", () => {
    expect(resolveVariables("{{v}}", { collection: [{ key: "v", value: "off", enabled: false }] })).toBe("{{v}}");
  });

  it("matches keys case-insensitively", () => {
    expect(resolveVariables("{{BASEURL}}", { environment: vars(["baseUrl", "x"]) })).toBe("x");
  });

  it("handles multiple placeholders and is single-pass", () => {
    const ctx = { collection: vars(["host", "localhost"], ["port", "8080"], ["a", "{{b}}"], ["b", "B"]) };
    expect(resolveVariables("http://{{host}}:{{port}}", ctx)).toBe("http://localhost:8080");
    expect(resolveVariables("{{a}}", ctx)).toBe("{{b}}");
  });

  it("finds placeholders with offsets", () => {
    expect(findPlaceholders("a {{x}} b {{ $guid }}")).toEqual([
      { name: "x", start: 2, end: 7 },
      { name: "$guid", start: 10, end: 21 },
    ]);
  });

  it("merges variables honoring precedence", () => {
    expect(mergedVariables({ request: vars(["a", "1"]), globals: vars(["a", "2"], ["b", "3"]) })).toEqual({ a: "1", b: "3" });
  });
});

describe("dynamic variables", () => {
  it("has the full catalog", () => {
    const names = new Set(DYNAMIC_VARIABLES.map((v) => v.name));
    for (const n of ["$guid", "$timestamp", "$randomFirstName", "$randomInt", "$isoTimestamp"]) expect(names.has(n)).toBe(true);
    expect(DYNAMIC_VARIABLES.length).toBeGreaterThan(80);
    expect(DYNAMIC_VARIABLES.every((v) => v.description && v.example !== undefined)).toBe(true);
  });

  it("recognizes known names only", () => {
    for (const n of ["$guid", "$randomUUID", "$timestamp", "$randomFirstName", "$randomEmail"]) expect(isDynamicVariable(n)).toBe(true);
    expect(isDynamicVariable("$notARealOne")).toBe(false);
    expect(isDynamicVariable("baseUrl")).toBe(false);
    expect(isDynamicVariable("")).toBe(false);
    expect(findDynamicVariable("$guid")?.description).toMatch(/guid/i);
  });

  it("generates valid values", () => {
    expect(tryGenerate("$guid")).toMatch(UUID);
    const n = Number(tryGenerate("$randomInt"));
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1000);
    expect(Number(tryGenerate("$timestamp"))).toBeGreaterThan(1_600_000_000);
    expect(tryGenerate("$nope")).toBeUndefined();
  });

  it("resolves through the resolver, fresh per occurrence, user variables winning", () => {
    expect(resolveVariables("id={{$guid}}", {})).toMatch(/^id=[0-9a-f-]{36}$/);
    expect(resolveVariables("{{$notARealOne}}", {})).toBe("{{$notARealOne}}");
    expect(resolveVariables("{{$guid}}", { request: vars(["$guid", "fixed"]) })).toBe("fixed");
    const [a, b] = resolveVariables("{{$randomUUID}}|{{$randomUUID}}", {}).split("|");
    expect(a).not.toBe(b);
    expect(lookupVariable("$guid", {})?.scope).toBe("dynamic");
  });
});
