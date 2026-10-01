import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// browser.ts must stay isomorphic: no node: builtins and no undici anywhere in its import graph.
describe("browser entry", () => {
  it("imports no node-only modules", () => {
    const srcDir = path.resolve(__dirname, "../src");
    const seen = new Set<string>();
    const external: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']/g)) {
        const spec = m[1];
        if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
        else external.push(spec);
      }
    };
    visit(path.join(srcDir, "browser.ts"));
    expect(external.filter((s) => s.startsWith("node:") || s === "undici" || s === "chai")).toEqual([]);
    expect([...seen].map((f) => path.basename(f))).not.toContain("workspaceStore.ts");
  });
});
