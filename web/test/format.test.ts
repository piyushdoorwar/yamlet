import { describe, expect, it } from "vitest";
import { prettyJson } from "../src/lib/format";

describe("prettyJson", () => {
  it("indents like JSON.stringify for ordinary values", () => {
    const text = '{"a":[1,2,{"b":null}],"c":{},"d":[],"e":"x, y: {z}","f":"q\\"uote"}';
    expect(prettyJson(text)).toBe(JSON.stringify(JSON.parse(text), null, 2));
  });

  it("keeps numbers and escapes exactly as sent", () => {
    expect(prettyJson('{"id":12345678901234567890,"p":1.50,"s":"\\u00e9"}')).toBe('{\n  "id": 12345678901234567890,\n  "p": 1.50,\n  "s": "\\u00e9"\n}');
    expect(prettyJson('{"a":123456789012345.6789}')).toBe('{\n  "a": 123456789012345.6789\n}');
  });

  it("leaves text that isn't JSON alone", () => {
    expect(prettyJson("{nope")).toBe("{nope");
    expect(prettyJson(" 42 ")).toBe("42");
  });
});
