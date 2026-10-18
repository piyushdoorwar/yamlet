import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Shows `card` below the trigger while it is hovered or focused. Rendered in a portal so clipping parents don't cut it. */
export function HoverCard({ children, card, label, width = 280 }: { children: ReactNode; card: ReactNode; label: string; width?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setAt({ top: r.bottom + 6, left });
  };
  const hide = () => setAt(null);
  return (
    <span ref={ref} tabIndex={0} aria-label={label} className="cursor-default rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/30" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {at &&
        createPortal(
          <div role="tooltip" style={{ top: at.top, left: at.left, width }} className="fixed z-50 rounded-lg border border-line bg-surface p-3 text-12 text-body shadow-lg">
            {card}
          </div>,
          document.body,
        )}
    </span>
  );
}
