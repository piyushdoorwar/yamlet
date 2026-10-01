import { describe, expect, it } from "vitest";
import { displayUrl, fromDisplayUrl, pathVariablesFromUrl } from "../src/lib/urlSync";

describe("URL and params sync", () => {
  it("splits the URL box into a bare URL and raw params", () => {
    const { url, queryParams } = fromDisplayUrl("{{baseUrl}}/users?page={{page}}&q=a%20b&flag#top", []);
    expect(url).toBe("{{baseUrl}}/users#top");
    expect(queryParams).toEqual([
      { key: "page", value: "{{page}}", enabled: true, description: undefined },
      { key: "q", value: "a%20b", enabled: true, description: undefined },
      { key: "flag", value: "", enabled: true, description: undefined },
    ]);
  });

  it("keeps disabled params and descriptions across edits", () => {
    const prev = [
      { key: "b", value: "1", enabled: true, description: "page size" },
      { key: "debug", value: "1", enabled: false },
    ];
    expect(fromDisplayUrl("https://x.test/a?b=2", prev).queryParams).toEqual([
      { key: "b", value: "2", enabled: true, description: "page size" },
      { key: "debug", value: "1", enabled: false },
    ]);
  });

  it("shows enabled params after the URL, including a legacy query in the URL", () => {
    const params = [
      { key: "a", value: "1", enabled: true },
      { key: "b", value: "2", enabled: false },
    ];
    expect(displayUrl("https://x.test/a#top", params)).toBe("https://x.test/a?a=1#top");
    expect(displayUrl("https://x.test/a?old=1", params)).toBe("https://x.test/a?old=1&a=1");
    expect(displayUrl("https://x.test/a", [])).toBe("https://x.test/a");
  });

  it("round-trips what the user typed", () => {
    for (const text of ["https://x.test/a?x=1&y", "{{base}}/p?q={{term}}&page=2", "https://x.test/"]) {
      const { url, queryParams } = fromDisplayUrl(text, []);
      expect(displayUrl(url, queryParams)).toBe(text);
    }
  });

  it("finds :path variables but not ports, keeping typed values", () => {
    const vars = pathVariablesFromUrl("http://localhost:8080/users/:id/posts/:postId?x=:nope", [{ key: "id", value: "42" }]);
    expect(vars).toEqual([
      { key: "id", value: "42" },
      { key: "postId", value: "" },
    ]);
  });
});
