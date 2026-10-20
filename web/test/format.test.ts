import { describe, expect, it } from "vitest";
import { prettyJson, suggestedFileName } from "../src/lib/format";

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

describe("suggestedFileName", () => {
  const cd = (value: string) => [{ key: "Content-Disposition", value }];
  it("reads Content-Disposition, preferring filename*", () => {
    expect(suggestedFileName(cd('attachment; filename="report 2024.csv"'), "https://h/x")).toBe("report 2024.csv");
    expect(suggestedFileName(cd("attachment; filename=plain.txt; size=3"), "https://h/x")).toBe("plain.txt");
    expect(suggestedFileName(cd(`attachment; filename="fallback.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`), "https://h/x")).toBe("résumé.pdf");
  });
  it("keeps only a plain name, and falls back to the URL", () => {
    expect(suggestedFileName(cd('attachment; filename="../../etc/passwd"'), "https://h/x")).toBe("passwd");
    expect(suggestedFileName([], "https://h/files/data.json?x=1")).toBe("data.json");
    expect(suggestedFileName([], "https://h/users/1")).toBeUndefined();
  });
});
