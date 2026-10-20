import { describe, expect, it } from "vitest";
import { withLocal } from "../src/components/ValueStorage";

describe("withLocal", () => {
  it("keeps a file variable's current-value override when set to File", () => {
    const v = { key: "token", value: "from-script", enabled: true, initialValue: "" };
    expect(withLocal(v, false)).toEqual(v);
    expect(withLocal(v, true)).toEqual({ key: "token", value: "from-script", enabled: true, local: true });
    expect(withLocal({ key: "t", value: "x", enabled: true, local: true }, false)).toEqual({ key: "t", value: "x", enabled: true });
  });
});
