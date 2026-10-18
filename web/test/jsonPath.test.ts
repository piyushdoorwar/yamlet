import { describe, expect, it } from "vitest";
import { JsonPathError, queryJson } from "../src/lib/jsonPath";

const store = {
  store: {
    book: [
      { category: "reference", author: "Nigel Rees", title: "Sayings", price: 8.95 },
      { category: "fiction", author: "Evelyn Waugh", title: "Sword", price: 12.99 },
      { category: "fiction", author: "Herman Melville", title: "Moby", isbn: "0-553", price: 8.99 },
    ],
    bicycle: { color: "red", price: 19.95 },
    "odd key": 1,
  },
};

describe("queryJson", () => {
  it("walks names, indexes and quoted keys", () => {
    expect(queryJson(store, "$.store.bicycle.color")).toEqual(["red"]);
    expect(queryJson(store, "$.store.book[0].title")).toEqual(["Sayings"]);
    expect(queryJson(store, "$.store.book[-1].title")).toEqual(["Moby"]);
    expect(queryJson(store, "$['store']['odd key']")).toEqual([1]);
    expect(queryJson(store, "$.store.book.length")).toEqual([3]);
    expect(queryJson(store, "$")).toEqual([store]);
  });

  it("handles wildcards, unions, slices and recursion", () => {
    expect(queryJson(store, "$.store.book[*].author")).toEqual(["Nigel Rees", "Evelyn Waugh", "Herman Melville"]);
    expect(queryJson(store, "$.store.book[0,2].title")).toEqual(["Sayings", "Moby"]);
    expect(queryJson(store, "$.store.book[1:].title")).toEqual(["Sword", "Moby"]);
    expect(queryJson(store, "$..price")).toEqual([8.95, 12.99, 8.99, 19.95]);
    expect(queryJson(store, "$.store.*").length).toBe(3);
  });

  it("filters with comparisons, existence, regex and boolean logic", () => {
    expect(queryJson(store, "$.store.book[?(@.price < 10)].title")).toEqual(["Sayings", "Moby"]);
    expect(queryJson(store, "$.store.book[?(@.isbn)].title")).toEqual(["Moby"]);
    expect(queryJson(store, "$.store.book[?(@.category == 'fiction' && @.price > 10)].title")).toEqual(["Sword"]);
    expect(queryJson(store, "$..book[?(@.author =~ /^H/)].title")).toEqual(["Moby"]);
  });

  it("handles quotes in filters, reverse slices and inherited names", () => {
    expect(queryJson([{ n: "a&&b" }, { n: "c" }], "$[?(@.n == 'a&&b')].n")).toEqual(["a&&b"]);
    expect(queryJson([1, 2, 3], "$[5::-1]")).toEqual([3, 2, 1]);
    expect(queryJson({ a: 1 }, "$.constructor")).toEqual([]);
  });

  it("explains paths it can't read", () => {
    expect(() => queryJson(store, "store.book")).toThrow(JsonPathError);
    expect(() => queryJson(store, "$.store[book]")).toThrow(/Quote names/);
    expect(() => queryJson(store, "$.store.book[0")).toThrow(/missing its \]/);
  });
});
