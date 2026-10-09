import { describe, expect, it } from "vitest";
import { inheritLocal, scopeIsLocal } from "../src/models.js";

describe("local scopes", () => {
  it("is local only when every variable is", () => {
    expect(scopeIsLocal([])).toBe(false);
    expect(scopeIsLocal([{ key: "a", value: "", enabled: true, local: true }])).toBe(true);
    expect(scopeIsLocal([{ key: "a", value: "", enabled: true, local: true }, { key: "b", value: "", enabled: true }])).toBe(false);
  });

  it("makes new variables local in a local scope", () => {
    const prev = [{ key: "token", value: "x", enabled: true, local: true }];
    const next = [...prev, { key: "id", value: "5", enabled: true }];
    expect(inheritLocal(prev, next)[1]).toEqual({ key: "id", value: "5", enabled: true, local: true });
    const mixed = [...prev, { key: "base", value: "u", enabled: true }];
    expect(inheritLocal(mixed, [...mixed, { key: "id", value: "5", enabled: true }])[2].local).toBeUndefined();
  });
});
