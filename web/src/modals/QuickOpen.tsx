import clsx from "clsx";
import { Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MethodLabel } from "../components/Labels";
import { useStore } from "../lib/store";
import { allRequests } from "../lib/tree";

interface Item {
  key: string;
  kind: "request" | "environment";
  id: string;
  title: string;
  detail: string;
  method?: string;
}

export function QuickOpen({ onClose }: { onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const openTab = useStore((s) => s.openTab);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const all = useMemo<Item[]>(() => {
    if (!workspace) return [];
    const items: Item[] = [];
    for (const c of workspace.collections) {
      for (const { request, path } of allRequests(c)) {
        items.push({ key: `r:${request.id}`, kind: "request", id: request.id, title: request.name, detail: [c.name, ...path].join(" / "), method: request.method });
      }
    }
    for (const e of workspace.environments) items.push({ key: `e:${e.id}`, kind: "environment", id: e.id, title: e.name, detail: "Environment" });
    return items;
  }, [workspace]);

  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return all.slice(0, 50);
    return all.filter((i) => terms.every((t) => `${i.title} ${i.detail} ${i.method ?? ""}`.toLowerCase().includes(t))).slice(0, 50);
  }, [all, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (i: Item | undefined) => {
    if (!i) return;
    openTab({ kind: i.kind, id: i.id });
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#0f1a14]/30 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Find a request">
        <div className="flex items-center gap-3 border-b border-line-soft px-4">
          <Search size={16} className="text-muted" aria-hidden />
          <input
            autoFocus
            className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-[#a3aea7]"
            placeholder="Search requests and environments"
            value={q}
            aria-label="Search"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                choose(results[sel]);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
        </div>
        <ul ref={list} className="max-h-96 overflow-y-auto py-1" role="listbox">
          {results.length === 0 && <li className="px-4 py-6 text-center text-13 text-muted">No matches.</li>}
          {results.map((i, idx) => (
            <li key={i.key} role="option" aria-selected={idx === sel}>
              <button
                type="button"
                onMouseEnter={() => setSel(idx)}
                onClick={() => choose(i)}
                className={clsx("flex w-full items-center gap-3 px-4 py-2 text-left", idx === sel ? "bg-primary-soft" : "")}
              >
                {i.method ? <MethodLabel method={i.method} short className="w-10 shrink-0" /> : <SlidersHorizontal size={14} className="w-10 shrink-0 text-grey" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-13 text-ink">{i.title}</span>
                  <span className="block truncate text-11 text-muted">{i.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
