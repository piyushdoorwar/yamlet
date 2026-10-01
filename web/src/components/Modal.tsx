import clsx from "clsx";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
  /** Fixed-height body that scrolls (pickers, long lists). */
  tall?: boolean;
}

export function Modal({ title, subtitle, children, footer, onClose, width = 460, tall }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f1a14]/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={clsx("flex max-h-[90vh] w-full flex-col rounded-lg bg-white shadow-xl", tall && "h-[80vh]")}
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <header className="flex items-start justify-between gap-4 border-b border-line-soft px-6 py-4">
            <div>
              <h2 className="text-base font-medium text-ink">{title}</h2>
              {subtitle && <p className="mt-0.5 text-13 text-muted">{subtitle}</p>}
            </div>
            <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 rounded-md p-1 text-muted hover:bg-line-soft hover:text-ink">
              <X size={18} aria-hidden />
            </button>
          </header>
        )}
        <div className={clsx("min-h-0 px-6 py-5 text-sm text-body", tall ? "flex-1 overflow-hidden" : "overflow-y-auto")}>{children}</div>
        {footer && <footer className="flex justify-end gap-3 border-t border-line-soft px-6 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
