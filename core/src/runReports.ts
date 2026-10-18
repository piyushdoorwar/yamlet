// Run reports as files: JUnit XML for CI dashboards and JSON. Used by the CLI and the
// Runner view, so it stays isomorphic.
import type { ScriptTestResult } from "./models.js";

/** What a report needs from each request result. */
export interface ReportResult {
  iteration: number;
  name: string;
  path: string[];
  collectionName: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  tests: ScriptTestResult[];
  passed: boolean;
  error?: string;
}

export interface ReportSummary {
  results: ReportResult[];
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  iterations: number;
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export function formatJunit(summary: ReportSummary): string {
  const byCollection = new Map<string, ReportResult[]>();
  for (const r of summary.results) byCollection.set(r.collectionName, [...(byCollection.get(r.collectionName) ?? []), r]);
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuites name="yamlet" tests="${summary.total}" failures="${summary.failed}" time="${(summary.durationMs / 1000).toFixed(3)}">`];
  for (const [name, results] of byCollection) {
    const failures = results.filter((r) => !r.passed).length;
    const time = results.reduce((t, r) => t + r.durationMs, 0) / 1000;
    lines.push(`  <testsuite name="${xml(name)}" tests="${results.length}" failures="${failures}" time="${time.toFixed(3)}">`);
    for (const r of results) {
      const case_ = `${[...r.path, r.name].join(" / ")}${summary.iterations > 1 ? ` [${r.iteration + 1}]` : ""}`;
      lines.push(`    <testcase classname="${xml(name)}" name="${xml(case_)}" time="${(r.durationMs / 1000).toFixed(3)}">`);
      if (!r.passed) {
        const bad = r.tests.filter((t) => !t.passed);
        const message = bad.length ? bad.map((t) => `${t.name}${t.error ? `: ${t.error}` : ""}`).join("; ") : (r.error ?? `HTTP ${r.status}`);
        lines.push(`      <failure message="${xml(message)}">${xml(`${r.method} ${r.url}\n${message}`)}</failure>`);
      }
      lines.push(`      <system-out>${xml(`${r.method} ${r.url} -> ${r.status || "ERROR"} in ${r.durationMs} ms`)}</system-out>`);
      lines.push("    </testcase>");
    }
    lines.push("  </testsuite>");
  }
  lines.push("</testsuites>");
  return lines.join("\n");
}

/** The summary as JSON, without the run's final variable values (they may hold secrets). */
export function formatJson(summary: ReportSummary & { variables?: unknown }): string {
  const { variables: _v, ...rest } = summary;
  return JSON.stringify(rest, null, 2);
}
