import type { SseEvent } from "@core/sse";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatBytes, formatMs, prettyJson } from "../../lib/format";

/** Keeps a scroll container pinned to the bottom while content grows, unless the user scrolled up. */
function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}

/** While a body arrives only its end is drawn; the whole body shows once it is complete. */
const LIVE_TAIL_CHARS = 64 * 1024;

/** Body text as it arrives. */
export function LiveText({ text }: { text: string }) {
  const ref = useStickToBottom<HTMLPreElement>(text.length);
  if (!text) return <p className="p-5 text-13 text-muted italic">Waiting for the body…</p>;
  const clipped = text.length > LIVE_TAIL_CHARS;
  return (
    <pre ref={ref} aria-label="Response body so far" className="h-full overflow-auto px-5 py-3 font-mono text-12 break-all whitespace-pre-wrap text-body">
      {clipped && <span className="mb-2 block font-sans text-muted italic">Showing the latest {formatBytes(LIVE_TAIL_CHARS)}; the full body appears when it is complete.</span>}
      {clipped ? text.slice(-LIVE_TAIL_CHARS) : text}
    </pre>
  );
}

function EventRow({ e, index }: { e: SseEvent; index: number }) {
  const [open, setOpen] = useState(false);
  const pretty = open ? prettyJson(e.data) : "";
  return (
    <li className="border-b border-line-soft last:border-0">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-5 py-2 text-left hover:bg-subtle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={14} className={clsx("mt-0.5 shrink-0 text-muted transition-transform", open && "rotate-90")} aria-hidden />
        <span className="w-10 shrink-0 text-right font-mono text-11 leading-5 text-muted">{index + 1}</span>
        <span className="w-16 shrink-0 font-mono text-11 leading-5 text-muted">{e.atMs !== undefined ? formatMs(e.atMs) : ""}</span>
        <span className="w-28 shrink-0 truncate text-12 leading-5 font-medium text-primary" title={e.event}>
          {e.event}
        </span>
        <span className={clsx("min-w-0 flex-1 font-mono text-12 leading-5 text-body", !open && "truncate")}>{open ? null : e.data}</span>
      </button>
      {open && (
        <div className="px-5 pb-3 pl-[13.5rem]">
          {e.id !== undefined && <p className="mb-1 text-11 text-muted">id {e.id}</p>}
          <pre className="overflow-x-auto rounded-md border border-line-soft bg-subtle p-3 font-mono text-12 break-all whitespace-pre-wrap text-body">{pretty}</pre>
        </div>
      )}
    </li>
  );
}

/** Server-sent events, newest at the bottom; click a row for the full data. */
export function EventsView({ events, live }: { events: SseEvent[]; live?: boolean }) {
  const ref = useStickToBottom<HTMLDivElement>(events.length);
  if (!events.length) {
    return <p className="p-5 text-13 text-muted italic">{live ? "Connected. Waiting for events…" : "No events were received."}</p>;
  }
  return (
    <div ref={ref} className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 flex gap-3 border-b border-line bg-surface px-5 py-1.5 text-11 font-medium tracking-wide text-muted uppercase">
        <span className="w-3.5 shrink-0" />
        <span className="w-10 shrink-0 text-right">#</span>
        <span className="w-16 shrink-0">Time</span>
        <span className="w-28 shrink-0">Event</span>
        <span>Data</span>
      </div>
      <ul>
        {events.map((e, i) => (
          <EventRow key={i} e={e} index={i} />
        ))}
      </ul>
    </div>
  );
}
