import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Menu } from "./Menu";

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  /** Small count or dot shown after the label. */
  badge?: ReactNode;
  /** Plain-text version of the badge for the overflow menu. */
  hint?: string;
}

/** Segmented control: a bordered pill group with a solid green active item. */
export function TabButton<T extends string>({ tabs, active, onChange, size = "md" }: { tabs: TabDef<T>[]; active: T; onChange: (id: T) => void; size?: "md" | "sm" }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-line bg-surface p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === active}
          onClick={() => onChange(t.id)}
          className={clsx(
            "rounded-md whitespace-nowrap transition-colors",
            size === "sm" ? "px-3 py-1 text-12" : "px-4 py-1.5 text-13",
            t.id === active ? "bg-primary text-white" : "text-grey hover:bg-line-soft",
          )}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

/**
 * Underlined tabs for editor sections (Params, Headers, Body, ...). Tabs that
 * don't fit move into a "More" menu; the active tab always stays visible.
 */
export function UnderlineTabs<T extends string>({ tabs, active, onChange, right }: { tabs: TabDef<T>[]; active: T; onChange: (id: T) => void; right?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState<T[]>(() => tabs.map((t) => t.id));
  const [menuOpen, setMenuOpen] = useState(false);
  const ids = tabs.map((t) => t.id).join("|");

  useLayoutEffect(() => {
    const el = box.current;
    const m = measure.current;
    if (!el || !m) return;
    const apply = (next: T[]) => setVisible((prev) => (prev.join("|") === next.join("|") ? prev : next));
    const fit = () => {
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth + 4);
      const available = el.clientWidth;
      const total = widths.reduce((a, w) => a + w, 0);
      if (total <= available) {
        apply(tabs.map((t) => t.id));
        return;
      }
      const room = available - 76; // the More button
      const shown: number[] = [];
      let used = 0;
      for (let i = 0; i < widths.length; i++) {
        if (used + widths[i] > room) break;
        shown.push(i);
        used += widths[i];
      }
      const activeIdx = tabs.findIndex((t) => t.id === active);
      if (activeIdx >= 0 && !shown.includes(activeIdx)) {
        while (shown.length && used + widths[activeIdx] > room) used -= widths[shown.pop()!];
        shown.push(activeIdx);
      }
      apply(shown.sort((x, y) => x - y).map((i) => tabs[i].id));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // `ids` tracks the tab set; badges may change widths too, so re-measure on any tabs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, active, tabs]);

  const hidden = tabs.filter((t) => !visible.includes(t.id));
  const button = (t: TabDef<T>, measuring = false) => (
    <button
      key={t.id}
      role={measuring ? undefined : "tab"}
      type="button"
      tabIndex={measuring ? -1 : undefined}
      aria-selected={measuring ? undefined : t.id === active}
      onClick={measuring ? undefined : () => onChange(t.id)}
      className={clsx(
        "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-13 whitespace-nowrap transition-colors",
        t.id === active ? "border-primary font-medium text-ink" : "border-transparent text-grey hover:text-ink",
      )}
    >
      {t.label}
      {t.badge}
    </button>
  );

  return (
    <div className="flex h-11 items-stretch border-b border-line-soft">
      <div ref={box} role="tablist" className="relative flex min-w-0 flex-1 items-stretch gap-1 overflow-hidden">
        {tabs.filter((t) => visible.includes(t.id)).map((t) => button(t))}
        {hidden.length > 0 && (
          <button
            ref={moreBtn}
            type="button"
            aria-haspopup="menu"
            aria-label={`${hidden.length} more tabs`}
            onClick={() => setMenuOpen(true)}
            className={clsx(
              "-mb-px flex shrink-0 items-center gap-1 border-b-2 px-2.5 text-13 whitespace-nowrap",
              hidden.some((t) => t.id === active) ? "border-primary text-ink" : "border-transparent text-grey hover:text-ink",
            )}
          >
            More
            <ChevronDown size={13} aria-hidden />
          </button>
        )}
        {/* Off-screen copy used to measure every tab's natural width. */}
        <div ref={measure} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex h-full gap-1">
          {tabs.map((t) => button(t, true))}
        </div>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2 pl-2">{right}</div>}
      {menuOpen && moreBtn.current && (
        <Menu
          at={moreBtn.current}
          onClose={() => setMenuOpen(false)}
          items={hidden.map((t) => ({ label: typeof t.label === "string" ? t.label : t.id, hint: t.hint, onSelect: () => onChange(t.id) }))}
        />
      )}
    </div>
  );
}

export function CountBadge({ n }: { n: number }) {
  if (!n) return null;
  return <span className="rounded-full bg-primary-soft px-1.5 text-11 leading-4 font-medium text-primary">{n}</span>;
}

export function Dot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="has content" />;
}
