import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

export type MenuEntry = MenuItem | "separator";

interface MenuProps {
  /** Viewport position (context menu) or the element to anchor below. */
  at: { x: number; y: number } | HTMLElement;
  items: MenuEntry[];
  onClose: () => void;
  align?: "start" | "end";
}

/** A floating menu used for context menus and "more" buttons. */
export function Menu({ at, items, onClose, align = "start" }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [focus, setFocus] = useState(-1);
  const actionable = items.map((it, i) => (it !== "separator" && !it.disabled ? i : -1)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if (at instanceof HTMLElement) {
      const r = at.getBoundingClientRect();
      left = align === "end" ? r.right - width : r.left;
      top = r.bottom + 4;
    } else {
      left = at.x;
      top = at.y;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    if (top + height > window.innerHeight - 8) top = Math.max(8, (at instanceof HTMLElement ? at.getBoundingClientRect().top - 4 : top) - height);
    setPos({ left, top });
  }, [at, align]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocus((f) => {
          const at = actionable.indexOf(f);
          const n = e.key === "ArrowDown" ? (at + 1) % actionable.length : (at - 1 + actionable.length) % actionable.length;
          return actionable[n] ?? -1;
        });
      } else if (e.key === "Enter" && focus >= 0) {
        e.preventDefault();
        const it = items[focus];
        if (it !== "separator") {
          onClose();
          it.onSelect();
        }
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, items, focus, actionable]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[70] min-w-48 rounded-lg border border-line bg-surface py-1 shadow-lg"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={`sep-${i}`} className="my-1 border-t border-line-soft" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onMouseEnter={() => setFocus(i)}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className={clsx(
              "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-13 disabled:opacity-40",
              it.danger ? "text-danger" : "text-body",
              focus === i && (it.danger ? "bg-danger-soft" : "bg-primary-soft text-primary"),
            )}
          >
            {it.icon ? <it.icon size={14} aria-hidden /> : <span className="w-3.5" />}
            <span className="flex-1">{it.label}</span>
            {it.hint && <span className="text-11 text-muted">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Hook to drive a Menu from a button or a right-click. */
export function useMenu() {
  const [state, setState] = useState<{ at: MenuProps["at"]; items: MenuEntry[]; align?: "start" | "end" } | null>(null);
  const node: ReactNode = state ? <Menu at={state.at} items={state.items} align={state.align} onClose={() => setState(null)} /> : null;
  return {
    node,
    openAt: (e: React.MouseEvent, items: MenuEntry[]) => {
      e.preventDefault();
      e.stopPropagation();
      setState({ at: { x: e.clientX, y: e.clientY }, items });
    },
    openBelow: (el: HTMLElement, items: MenuEntry[], align: "start" | "end" = "start") => setState({ at: el, items, align }),
    close: () => setState(null),
  };
}
