import clsx from "clsx";
import { CircleCheck, CircleX, FileSpreadsheet, Play, Square, X } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import type { RunEvent } from "../../../shared/api";
import { Button } from "../components/Button";
import { MethodLabel, StatusPill } from "../components/Labels";
import { Card, PageHeader } from "../components/Page";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { formatMs } from "../lib/format";
import { useStore } from "../lib/store";
import { allRequests, findFolder } from "../lib/tree";

type Result = Extract<RunEvent, { type: "result" }>;
type Summary = Extract<RunEvent, { type: "summary" }>;

export function RunnerView({ collectionId, folderId }: { collectionId: string; folderId?: string }) {
  const workspace = useStore((s) => s.workspace);
  const environmentId = useStore((s) => s.environmentId);
  const applyWorkspace = useStore((s) => s.applyWorkspace);
  const toast = useToast();
  const collection = workspace?.collections.find((c) => c.id === collectionId);
  const folder = folderId ? findFolder(workspace, folderId)?.folder : undefined;
  const scope = folder ?? collection;
  const items = useMemo(() => (scope ? allRequests(scope) : []), [scope]);
  const env = workspace?.environments.find((e) => e.id === environmentId);

  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [iterations, setIterations] = useState(1);
  const [delayMs, setDelayMs] = useState(0);
  const [bail, setBail] = useState(false);
  const [data, setData] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!collection || !scope) return <p className="p-8 text-13 text-muted">This collection no longer exists.</p>;

  const selected = items.filter((i) => !excluded.has(i.request.id));
  const plannedIterations = data ? data.rows : iterations;
  const planned = selected.length * plannedIterations;

  const loadData = async (file: File) => {
    const text = await file.text();
    let rows = 0;
    try {
      if (file.name.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed.length : 0;
      } else {
        rows = Math.max(0, text.split(/\r?\n/).filter((l) => l.trim()).length - 1);
      }
    } catch {
      toast.error("Could not read the data file", "Use CSV with a header row, or a JSON array of objects.");
      return;
    }
    if (!rows) {
      toast.error("The data file has no rows");
      return;
    }
    setData({ name: file.name, text, rows });
  };

  const run = async () => {
    setRunning(true);
    setResults([]);
    setSummary(null);
    setExpanded(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await api.run(
        {
          collectionId,
          folderId,
          requestIds: excluded.size ? selected.map((s) => s.request.id) : undefined,
          environmentId,
          iterations: data ? undefined : iterations,
          delayMs,
          bail,
          dataText: data?.text,
          dataFileName: data?.name,
        },
        (e) => {
          if (e.type === "result") setResults((r) => [...r, e]);
          else if (e.type === "summary") setSummary(e);
          else toast.error("Run failed", e.error);
        },
        controller.signal,
      );
      // Scripts may have changed variables on disk during the run.
      const { workspace: fresh } = await api.reloadWorkspace();
      applyWorkspace(fresh);
    } catch (err) {
      if (!controller.signal.aborted) toast.error("Run failed", errorMessage(err));
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const progress = planned ? Math.min(100, (results.length / planned) * 100) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 pt-8 pb-14">
        <PageHeader
          icon={<Play size={20} aria-hidden />}
          title={`Run ${folder?.name ?? collection.name}`}
          subtitle={folder ? `${collection.name} / ${folder.name}` : `${items.length} requests`}
          actions={
            running ? (
              <Button variant="cancel" icon={Square} onClick={() => abort.current?.abort()}>
                Stop
              </Button>
            ) : (
              <Button icon={Play} disabled={!selected.length} onClick={() => void run()}>
                Run {selected.length} request{selected.length === 1 ? "" : "s"}
              </Button>
            )
          }
        />

        <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
          <div className="space-y-5">
            <Card title="Run settings">
              <div className="space-y-4">
                <div>
                  <span className="label">Environment</span>
                  <p className="text-13 text-ink">{env?.name ?? <span className="text-muted">None (choose one in the top bar)</span>}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label" htmlFor="run-iter">
                      Iterations
                    </label>
                    <input id="run-iter" type="number" min={1} max={1000} className="input" disabled={!!data} value={data ? data.rows : iterations} onChange={(e) => setIterations(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
                  </div>
                  <div>
                    <label className="label" htmlFor="run-delay">
                      Delay (ms)
                    </label>
                    <input id="run-delay" type="number" min={0} step={100} className="input" value={delayMs} onChange={(e) => setDelayMs(Math.max(0, Number(e.target.value) || 0))} />
                  </div>
                </div>
                <div>
                  <span className="label">Data file</span>
                  <input ref={fileInput} type="file" accept=".csv,.json,text/csv,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void loadData(e.target.files[0])} />
                  {data ? (
                    <div className="flex items-center gap-2 rounded-md border border-line bg-subtle px-3 py-2 text-13">
                      <FileSpreadsheet size={15} className="text-primary" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{data.name}</span>
                      <span className="text-12 text-muted">{data.rows} rows</span>
                      <button type="button" aria-label="Remove data file" className="text-muted hover:text-danger" onClick={() => setData(null)}>
                        <X size={14} aria-hidden />
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-cancel btn-sm w-full" onClick={() => fileInput.current?.click()}>
                      <FileSpreadsheet size={13} aria-hidden /> Select CSV or JSON
                    </button>
                  )}
                  <p className="mt-1 text-11 text-muted">One iteration per row. Read values with {"{{column}}"} or pm.iterationData.get("column").</p>
                </div>
                <label className="flex items-center gap-2 text-13 text-body">
                  <input type="checkbox" className="check" checked={bail} onChange={(e) => setBail(e.target.checked)} /> Stop at the first failure
                </label>
              </div>
            </Card>

            <Card
              title={`Requests (${selected.length}/${items.length})`}
              flush
              actions={
                <span className="flex gap-3 text-12">
                  <button type="button" className="font-medium text-primary hover:underline" onClick={() => setExcluded(new Set())}>
                    All
                  </button>
                  <button type="button" className="font-medium text-primary hover:underline" onClick={() => setExcluded(new Set(items.map((i) => i.request.id)))}>
                    None
                  </button>
                </span>
              }
            >
              <ul className="max-h-96 overflow-y-auto py-1">
                {items.map(({ request, path }) => (
                  <li key={request.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 px-4 py-1.5 hover:bg-primary-soft">
                      <input
                        type="checkbox"
                        className="check"
                        checked={!excluded.has(request.id)}
                        onChange={(e) => {
                          const next = new Set(excluded);
                          if (e.target.checked) next.delete(request.id);
                          else next.add(request.id);
                          setExcluded(next);
                        }}
                      />
                      <MethodLabel method={request.method} short className="w-9" />
                      <span className="min-w-0 flex-1 truncate text-13">{[...path, request.name].join(" / ")}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card
            title="Results"
            flush
            actions={
              results.length > 0 && (
                <span className="flex items-center gap-3 text-12">
                  <span className="font-medium text-primary">{passed} passed</span>
                  <span className={clsx("font-medium", failed ? "text-danger" : "text-muted")}>{failed} failed</span>
                  {summary && <span className="text-muted">{formatMs(summary.durationMs)}</span>}
                </span>
              )
            }
          >
            {(running || results.length > 0) && (
              <div className="h-1 bg-line-soft" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
                <div className={clsx("h-1 transition-all", failed ? "bg-danger" : "bg-primary")} style={{ width: `${summary ? 100 : progress}%` }} />
              </div>
            )}
            {results.length === 0 ? (
              <p className="p-8 text-center text-13 text-muted">{running ? "Starting…" : "Choose requests and press Run. Results stream in as each request finishes."}</p>
            ) : (
              <table className="w-full text-13">
                <thead>
                  <tr className="border-b border-line-soft text-left text-12 text-grey">
                    {plannedIterations > 1 && <th className="px-4 py-2 font-normal">#</th>}
                    <th className="px-4 py-2 font-normal">Request</th>
                    <th className="px-4 py-2 font-normal">Status</th>
                    <th className="px-4 py-2 text-right font-normal">Time</th>
                    <th className="px-4 py-2 text-right font-normal">Tests</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    const tp = r.tests.filter((t) => t.passed).length;
                    const open = expanded === i;
                    const hasDetail = !!r.error || r.tests.length > 0;
                    return (
                      <Fragment key={i}>
                        <tr
                          className={clsx("border-b border-line-soft", hasDetail && "cursor-pointer hover:bg-subtle")}
                          onClick={() => hasDetail && setExpanded(open ? null : i)}
                        >
                          {plannedIterations > 1 && <td className="px-4 py-2 text-12 text-muted">{r.iteration + 1}</td>}
                          <td className="px-4 py-2">
                            <span className="flex items-center gap-2">
                              {r.passed ? <CircleCheck size={15} className="shrink-0 text-primary" aria-label="Passed" /> : <CircleX size={15} className="shrink-0 text-danger" aria-label="Failed" />}
                              <MethodLabel method={r.method} short className="w-9 shrink-0" />
                              <span className="min-w-0">
                                <span className="block truncate text-ink">{[...r.path, r.name].join(" / ")}</span>
                                <span className="block truncate font-mono text-11 text-muted">{r.url}</span>
                              </span>
                            </span>
                          </td>
                          <td className="px-4 py-2">{r.error && !r.status ? <span className="text-12 text-danger">Error</span> : <StatusPill status={r.status} />}</td>
                          <td className="px-4 py-2 text-right text-12 text-grey">{formatMs(r.durationMs)}</td>
                          <td className={clsx("px-4 py-2 text-right text-12", tp === r.tests.length ? "text-grey" : "font-medium text-danger")}>{r.tests.length ? `${tp}/${r.tests.length}` : "–"}</td>
                        </tr>
                        {open && (
                          <tr className="border-b border-line-soft bg-subtle">
                            <td colSpan={plannedIterations > 1 ? 5 : 4} className="px-6 py-3">
                              {r.error && <p className="mb-2 font-mono text-12 text-danger">{r.error}</p>}
                              <ul className="space-y-1">
                                {r.tests.map((t, j) => (
                                  <li key={j} className="flex items-start gap-2 text-12">
                                    {t.passed ? <CircleCheck size={13} className="mt-0.5 text-primary" aria-hidden /> : <CircleX size={13} className="mt-0.5 text-danger" aria-hidden />}
                                    <span>
                                      {t.name}
                                      {t.error && <span className="block font-mono text-danger">{t.error}</span>}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
