import { describe, expect, it } from "vitest";
import { CookieJar, parseSetCookie } from "../src/cookieJar.js";

describe("CookieJar", () => {
  it("parses Set-Cookie attributes", () => {
    const c = parseSetCookie("sid=abc; Domain=.Example.com; Path=/app; Secure; HttpOnly; SameSite=Lax; Max-Age=60")!;
    expect(c).toMatchObject({ name: "sid", value: "abc", domain: "example.com", path: "/app", secure: true, httpOnly: true, sameSite: "Lax" });
    expect(Date.parse(c.expires!)).toBeGreaterThan(Date.now());
    expect(parseSetCookie("novalue")).toBeUndefined();
  });

  it("matches host-only and domain cookies", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://api.example.com/v1/login", ["host=1", "dom=2; Domain=example.com; Path=/", "evil=3; Domain=other.com"]);
    expect(jar.cookieHeaderFor("https://api.example.com/v1/x")).toBe("host=1; dom=2");
    expect(jar.cookieHeaderFor("https://www.example.com/")).toBe("dom=2");
    expect(jar.cookieHeaderFor("https://other.com/")).toBeUndefined();
    expect(jar.list()).toHaveLength(2);
  });

  it("applies default paths and path matching", () => {
    const jar = new CookieJar();
    jar.setFromResponse("http://h.test/a/b/c", ["d=1", "root=2; Path=/"]);
    expect(jar.cookieHeaderFor("http://h.test/a/b/x")).toBe("d=1; root=2");
    expect(jar.cookieHeaderFor("http://h.test/a/bc")).toBe("root=2");
    expect(jar.cookieHeaderFor("http://h.test/")).toBe("root=2");
  });

  it("honors secure, expiry and replacement", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://h.test/", ["s=1; Secure", "old=1"]);
    expect(jar.cookieHeaderFor("http://h.test/")).toBe("old=1");
    expect(jar.cookieHeaderFor("https://h.test/")).toBe("s=1; old=1");
    jar.setFromResponse("https://h.test/", ["old=2"]);
    expect(jar.cookieHeaderFor("https://h.test/")).toBe("s=1; old=2");
    jar.setFromResponse("https://h.test/", ["old=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
    expect(jar.cookieHeaderFor("https://h.test/")).toBe("s=1");
  });

  it("removes, clears and serializes", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://a.test/", ["x=1", "y=2"]);
    jar.setFromResponse("https://b.test/", ["z=3"]);
    const copy = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar)));
    expect(copy.list().map((c) => c.name).sort()).toEqual(["x", "y", "z"]);
    copy.remove("a.test", "x");
    expect(copy.cookieHeaderFor("https://a.test/")).toBe("y=2");
    copy.clear("b.test");
    expect(copy.cookieHeaderFor("https://b.test/")).toBeUndefined();
    copy.clear();
    expect(copy.list()).toEqual([]);
  });
});
