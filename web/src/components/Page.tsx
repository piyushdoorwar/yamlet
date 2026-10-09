import { Check, CircleAlert, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">{icon}</span>}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-medium text-ink">{title}</h1>
          {subtitle && <p className="mt-0.5 truncate text-13 text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "", flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          {actions}
        </header>
      )}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

export function SaveStatus({ status, error, onRetry }: { status: "idle" | "saving" | "saved" | "error"; error?: string | null; onRetry?: () => void }) {
  if (status === "saving")
    return (
      <span className="flex items-center gap-1 text-12 text-muted">
        <Loader2 size={13} className="spin" aria-hidden /> Saving
      </span>
    );
  if (status === "error")
    return (
      <span role="alert" className="flex max-w-md items-center gap-2 text-12 text-danger">
        <CircleAlert size={13} className="shrink-0" aria-hidden />
        <span className="truncate" title={error ?? undefined}>
          Not saved{error ? `: ${error}` : ""}
        </span>
        {onRetry && (
          <button type="button" className="shrink-0 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary-soft" onClick={onRetry}>
            Retry
          </button>
        )}
      </span>
    );
  if (status === "saved")
    return (
      <span className="flex items-center gap-1 text-12 text-muted">
        <Check size={13} aria-hidden /> Saved to disk
      </span>
    );
  return null;
}

export function ScrollPage({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 pt-8 pb-14">{children}</div>
    </div>
  );
}
