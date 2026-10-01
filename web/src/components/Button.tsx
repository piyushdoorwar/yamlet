import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type Variant = "primary" | "cancel" | "delete" | "ghost";

interface ButtonProps {
  children?: ReactNode;
  variant?: Variant;
  size?: "md" | "sm";
  icon?: LucideIcon;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
}

export function Button({ children, variant = "primary", size = "md", icon: Icon, onClick, disabled, type = "button", title, className }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {Icon && <Icon size={size === "sm" ? 13 : 14} strokeWidth={2} aria-hidden />}
      {children}
    </button>
  );
}

interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  size?: number;
  className?: string;
}

export function IconButton({ icon: Icon, label, onClick, disabled, danger, active, size = 15, className }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
        disabled
          ? "text-[#c4ccc7]"
          : danger
            ? "text-danger hover:bg-danger-soft"
            : active
              ? "bg-primary-soft text-primary"
              : "text-grey hover:bg-primary-soft hover:text-primary",
        className,
      )}
    >
      <Icon size={size} strokeWidth={2} aria-hidden />
    </button>
  );
}
