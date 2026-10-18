import type { KeyValue } from "@core/models";
import clsx from "clsx";
import { ChevronRight, CircleAlert, Copy, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../components/Button";
import { MethodLabel, StatusPill } from "../components/Labels";
import { useToast } from "../components/Toast";
import { type ConsoleEntry, type ConsoleLog, useConsole } from "../lib/consoleLog";
import { copyText, formatBytes, formatMs, prettyJson } from "../lib/format";

type Filter = "all" | "requests" | "logs" | "errors";

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });

function failed(e: ConsoleEntry) {
  return !!e.error || e.logs.some((l) => l.level === "error");
}

function matches(e: ConsoleEntry, q: string) {
  if (!q) return true;
  const s = q.toLowerCase();
  return [e.url, e.requestName, e.method, String(e.status), e.error ?? "", ...e.logs.map((l) => l.text)].some((t) => t.toLowerCase().includes(s));
}

function LogLine({ log }: { log: ConsoleLog }) {
  return (
    <div
      className={clsx(
        "flex items-start gap-2 border-b border-line-soft px-4 py-1 pl-9 font-mono text-12 break-all whitespace-pre-wrap",
        log.level === "error" ? "bg-danger-soft text-danger" : log.level === "warn" ? "bg-s-client text-s-client-ink" : "text-body",
      )}
    >
      {log.level === "error" ? <CircleAlert size={12} className="mt-0.5 shrink-0" aria-label="Error" /> : log.level === "warn" ? <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-label="Warning" /> : null}
      <span className="min-w-0">{log.text}</span>
    </div>
  );
}

function Headers({ rows }: { rows: KeyValue[] }) {
  if (!rows.length) return <p className="text-12 text-muted italic">None</p>;
  return (
    <dl className="grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-4 gap-y-0.5 font-mono text-12">
      {rows.map((h, i) => (
        <div key={i} className="contents">
          <dt className="text-grey">{h.key}</dt>
          <dd className="break-all text-body">{h.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children, copy }: { title: string; children: React.ReactNode; copy?: string }) {
  const toast = useToast();
  return (
    <section className="min-w-0">
      <h4 className="mb-1 flex items-center gap-1 text-11 font-medium tracking-wide text-muted uppercase">
        {title}
        {copy !== undefined && (
          <IconButton icon={Copy} size={12} label={`Copy ${title.toLowerCase()}`} onClick={() => void copyText(copy).then((ok) => ok && toast.success("Copied"))} />
        )}
      </h4>
      {children}
    </section>
  );
}

function Body({ text, binary, size }: { text?: string; binary?: boolean; size?: number }) {
  if (binary) return <p className="text-12 text-muted italic">Binary body ({formatBytes(size ?? 0)})</p>;
  if (!text) return <p className="text-12 text-muted italic">Empty</p>;
  return <pre className="max-h-64 overflow-auto rounded-md border border-line-soft bg-subtle p-2 font-mono text-12 break-all whitespace-pre-wrap text-body">{prettyJson(text)}</pre>;
}

function EntryRow({ e, showRequest, showLogs }: { e: ConsoleEntry; showRequest: boolean; showLogs: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      {showRequest && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={clsx("flex w-full items-center gap-2 border-b border-line-soft px-4 py-1.5 text-left text-12 hover:bg-subtle", e.error && "bg-danger-soft")}
        >
          <ChevronRight size={13} className={clsx("shrink-0 text-muted transition-transform", open && "rotate-90")} aria-hidden />
          <span className="w-16 shrink-0 font-mono text-11 text-muted">{time(e.at)}</span>
          <MethodLabel method={e.method} className="w-14 shrink-0 text-11" />
          <span className="min-w-0 flex-1 truncate font-mono text-body" title={e.url}>
            {e.url}
          </span>
          {e.error ? (
            <span className="max-w-[50%] min-w-0 truncate text-danger" title={e.error}>
              {e.error}
            </span>
          ) : (
            <>
              <StatusPill status={e.status} text={e.reasonPhrase} />
              <span className="w-14 shrink-0 text-right text-muted">{formatMs(e.durationMs)}</span>
              <span className="w-16 shrink-0 text-right text-muted">{formatBytes(e.sizeBytes)}</span>
            </>
          )}
        </button>
      )}
      {open && showRequest && (
        <div className="grid gap-4 border-b border-line-soft bg-surface px-9 py-3 @3xl:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <Section title="Request headers">
              <Headers rows={e.requestHeaders} />
            </Section>
            <Section title="Request body" copy={e.requestBody ?? ""}>
              <Body text={e.requestBody} />
            </Section>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            {e.incomplete && <p className="rounded-md bg-s-client px-2 py-1 text-12 text-s-client-ink">{e.incomplete}</p>}
            <Section title="Response headers">
              <Headers rows={e.responseHeaders} />
            </Section>
            <Section title="Response body" copy={e.binary ? undefined : e.responseBody}>
              <Body text={e.responseBody} binary={e.binary} size={e.sizeBytes} />
            </Section>
          </div>
        </div>
      )}
      {showLogs && e.logs.map((l, i) => <LogLine key={i} log={l} />)}
    </li>
  );
}

/** Every request sent from this browser tab, newest at the bottom, with its script output. */
export function ConsolePanel() {
  const entries = useConsole((s) => s.entries);
  const clear = useConsole((s) => s.clear);
  const setOpen = useConsole((s) => s.setOpen);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () =>
      entries.filter((e) => matches(e, query) && (filter === "all" || filter === "requests" || (filter === "logs" ? e.logs.length > 0 : failed(e)))),
    [entries, filter, query],
  );

  // Follow new entries while the list is scrolled to the bottom.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <section aria-label="Console" className="@container flex h-full min-h-0 flex-col border-t border-line bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <h3 className="text-12 font-medium tracking-wide text-muted uppercase">Console</h3>
        <select className="input h-6 w-28 py-0 text-12" aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">All</option>
          <option value="requests">Requests</option>
          <option value="logs">Logs</option>
          <option value="errors">Errors</option>
        </select>
        <label className="relative flex min-w-0 flex-1 items-center">
          <Search size={12} className="pointer-events-none absolute left-2 text-muted" aria-hidden />
          <input className="input h-6 max-w-72 py-0 pl-6 text-12" placeholder="Filter by URL, status or text" aria-label="Filter console" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <IconButton icon={Trash2} size={13} label="Clear console" onClick={clear} />
        <IconButton icon={X} size={14} label="Close console" onClick={() => setOpen(false)} />
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(ev) => {
          const el = ev.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {shown.length === 0 ? (
          <p className="p-4 text-12 text-muted">{entries.length ? "Nothing matches the filter." : "Requests you send, and console.log output from their scripts, appear here."}</p>
        ) : (
          <ul>
            {shown.map((e) => (
              <EntryRow key={e.id} e={e} showRequest={filter !== "logs"} showLogs={filter !== "requests"} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
