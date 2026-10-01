import clsx from "clsx";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";

interface ToastItem {
  id: number;
  kind: "success" | "error";
  summary: string;
  detail?: string;
}

interface Notify {
  success: (summary: string, detail?: string) => void;
  error: (summary: string, detail?: string) => void;
}

const ToastContext = createContext<Notify | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: ToastItem["kind"], summary: string, detail?: string) => {
      const id = next.current++;
      setItems((all) => [...all.slice(-3), { id, kind, summary, detail }]);
      setTimeout(() => dismiss(id), kind === "error" ? 7000 : 3200);
    },
    [dismiss],
  );
  const notify = useMemo<Notify>(
    () => ({ success: (s, d) => push("success", s, d), error: (s, d) => push("error", s, d) }),
    [push],
  );

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="pointer-events-none fixed top-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={clsx(
              "toast-in pointer-events-auto flex items-start gap-3 rounded-lg border bg-white px-4 py-3 shadow-lg",
              t.kind === "error" ? "border-[#ffc9d6]" : "border-line",
            )}
          >
            {t.kind === "error" ? (
              <CircleAlert size={17} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            ) : (
              <CircleCheck size={17} className="mt-0.5 shrink-0 text-primary" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-13 font-medium text-ink">{t.summary}</p>
              {t.detail && <p className="mt-0.5 text-12 break-words text-grey">{t.detail}</p>}
            </div>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-muted hover:text-ink">
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
