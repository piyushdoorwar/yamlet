import { History } from "lucide-react";
import { MethodLabel, StatusPill } from "../components/Labels";
import { useDialogs } from "../components/Dialogs";
import { type HistoryEntry, useStore } from "../lib/store";
import { findRequest } from "../lib/tree";

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function HistoryList({ filter }: { filter: string }) {
  const history = useStore((s) => s.history);
  const clearHistory = useStore((s) => s.clearHistory);
  const { confirm } = useDialogs();
  const q = filter.trim().toLowerCase();
  const visible = history.filter((h) => !q || h.url.toLowerCase().includes(q) || h.name.toLowerCase().includes(q));

  if (!history.length) {
    return (
      <div className="px-6 py-8 text-center">
        <History size={26} className="mx-auto text-faint" aria-hidden />
        <p className="mt-3 text-13 text-grey">Requests you send appear here.</p>
      </div>
    );
  }

  const groups = new Map<string, HistoryEntry[]>();
  for (const h of visible) {
    const k = dayLabel(h.at);
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }

  const open = (h: HistoryEntry) => {
    const s = useStore.getState();
    if (findRequest(s.workspace, h.requestId)) {
      s.openTab({ kind: "request", id: h.requestId });
    }
  };

  return (
    <div className="pb-6">
      <div className="flex justify-end px-4 pb-1">
        <button
          type="button"
          className="text-12 text-muted hover:text-danger"
          onClick={async () => (await confirm({ title: "Clear history", message: "Remove every history entry for this workspace?", action: "Clear", danger: true })) && clearHistory()}
        >
          Clear all
        </button>
      </div>
      {[...groups].map(([day, entries]) => (
        <div key={day}>
          <p className="mt-2 mb-1 px-4 text-11 font-medium tracking-wide text-muted uppercase">{day}</p>
          {entries.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => open(h)}
              className="mx-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-primary-soft"
              title={h.url}
            >
              <MethodLabel method={h.method} short className="w-9 shrink-0 text-right" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-13 text-body">{h.name}</span>
                <span className="block truncate font-mono text-11 text-muted">{h.url}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                <StatusPill status={h.isError ? 0 : h.status} />
                <span className="text-11 text-muted">{new Date(h.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
