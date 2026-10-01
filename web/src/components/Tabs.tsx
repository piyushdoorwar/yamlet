import clsx from "clsx";
import type { ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  /** Small count or dot shown after the label. */
  badge?: ReactNode;
}

/** Segmented control: a bordered pill group with a solid green active item. */
export function TabButton<T extends string>({ tabs, active, onChange, size = "md" }: { tabs: TabDef<T>[]; active: T; onChange: (id: T) => void; size?: "md" | "sm" }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-line bg-white p-1">
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

/** Underlined tabs for editor sections (Params, Headers, Body, ...). */
export function UnderlineTabs<T extends string>({ tabs, active, onChange, right }: { tabs: TabDef<T>[]; active: T; onChange: (id: T) => void; right?: ReactNode }) {
  return (
    <div className="flex items-center border-b border-line-soft">
      <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 no-scrollbar overflow-x-auto overflow-y-hidden">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={t.id === active}
            onClick={() => onChange(t.id)}
            className={clsx(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-13 whitespace-nowrap transition-colors",
              t.id === active ? "border-primary font-medium text-ink" : "border-transparent text-grey hover:text-ink",
            )}
          >
            {t.label}
            {t.badge}
          </button>
        ))}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2 pl-2">{right}</div>}
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
