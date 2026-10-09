import clsx from "clsx";
import { Check, CircleAlert, Copy, Eye, EyeOff, Loader2, Pencil, Plus, TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { DYNAMIC_VARIABLES } from "@core/dynamicVariables";
import { copyText } from "../lib/format";

/** A scope the peek can write a variable to, in precedence order (highest first). */
export interface VariableTarget {
  scope: "request" | "collection" | "environment" | "globals";
  /** Shown in the scope picker, e.g. "Environment: dev". */
  label: string;
  write: (name: string, value: string) => Promise<void> | void;
}

export interface VariableInfo {
  value: string;
  scope: string;
  secret?: boolean;
}

/** What the editor needs to color, peek and edit `{{variables}}`. */
export interface VariableSource {
  lookup: (name: string) => VariableInfo | undefined;
  names: () => { name: string; scope: string; value: string }[];
  /** Scopes the peek can write to; empty or missing makes the peek read-only. */
  targets?: VariableTarget[];
  /** Bumps whenever lookups would change, so decorations refresh. */
  version: string;
}

const DYNAMIC_BY_NAME = new Map(DYNAMIC_VARIABLES.map((d) => [d.name.replace(/^\$/, ""), d]));

export function dynamicInfo(name: string) {
  return name.startsWith("$") ? DYNAMIC_BY_NAME.get(name.slice(1)) : undefined;
}

/** True when `{{name}}` resolves to a non-empty value (user variable or dynamic). */
export function isResolved(source: VariableSource, name: string): boolean {
  if (dynamicInfo(name)) return true;
  const info = source.lookup(name);
  return !!info && info.value !== "";
}

const SCOPE_LABEL: Record<string, string> = {
  request: "Request",
  data: "Data file",
  collection: "Collection",
  environment: "Environment",
  globals: "Globals",
  dynamic: "Dynamic",
};

const PRECEDENCE = ["request", "data", "collection", "environment", "globals"];

interface Props {
  name: string;
  source: VariableSource;
  /** Pinned peeks open straight into the editor and stay until saved or dismissed. */
  pinned: boolean;
  onEdit: () => void;
  /** `refocus` returns focus to the editor (not wanted when the user clicked elsewhere). */
  onClose: (refocus?: boolean) => void;
}

export function VariablePeek({ name, source, pinned, onEdit, onClose }: Props) {
  const dyn = dynamicInfo(name);
  const info = source.lookup(name);
  const targets = source.targets ?? [];
  const resolved = !!info && info.value !== "";
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);

  if (dyn) {
    return (
      <div className="w-80 p-3 text-12">
        <Header name={name} chip={<Chip tone="ok">Dynamic</Chip>} />
        <p className="text-grey">{dyn.description}</p>
        <p className="mt-2 font-mono break-all text-body">
          <span className="text-muted">e.g. </span>
          {dyn.example}
        </p>
        <p className="mt-2 text-11 text-muted">A fresh value is generated every time it is used.</p>
      </div>
    );
  }

  if (pinned && targets.length) {
    return <PeekEditor name={name} info={info} targets={targets} onClose={onClose} />;
  }

  const masked = info?.secret && !reveal;
  return (
    <div className="w-80 p-3 text-12">
      <Header
        name={name}
        chip={
          info ? (
            <Chip tone={resolved ? "ok" : "warn"}>{SCOPE_LABEL[info.scope] ?? info.scope}</Chip>
          ) : (
            <Chip tone="warn">Unresolved</Chip>
          )
        }
      />
      {info ? (
        <div className="flex items-start gap-1">
          <div className={clsx("min-w-0 flex-1 rounded-md bg-subtle px-2 py-1.5 font-mono break-all", info.value ? "text-ink" : "text-muted italic")}>
            {info.value ? (masked ? "•".repeat(Math.min(info.value.length, 16)) : info.value) : "Empty value"}
          </div>
          {info.secret && info.value && <IconBtn label={reveal ? "Hide value" : "Show value"} icon={reveal ? EyeOff : Eye} onClick={() => setReveal((r) => !r)} />}
          {info.value && (
            <IconBtn
              label={copied ? "Copied" : "Copy value"}
              icon={copied ? Check : Copy}
              onClick={async () => {
                if (await copyText(info.value)) setCopied(true);
              }}
            />
          )}
          {targets.length > 0 && <IconBtn label="Edit value" icon={Pencil} onClick={onEdit} />}
        </div>
      ) : (
        <p className="flex items-start gap-1.5 text-grey">
          <TriangleAlert size={14} className="mt-px shrink-0 text-warning" aria-hidden />
          <span>Not defined in the request, collection, active environment or globals. It is sent as typed.</span>
        </p>
      )}
      {info && !info.value && <p className="mt-2 text-11 text-muted">Defined but empty, so the request sends an empty string.</p>}
      {!info && targets.length > 0 && (
        <button type="button" className="btn btn-primary btn-sm mt-3 w-full" onClick={onEdit}>
          <Plus size={14} aria-hidden /> Add variable
        </button>
      )}
      {!targets.length && !info && <p className="mt-2 text-11 text-muted">Select an environment to define variables from here.</p>}
    </div>
  );
}

function PeekEditor({ name, info, targets, onClose }: { name: string; info: VariableInfo | undefined; targets: VariableTarget[]; onClose: (refocus?: boolean) => void }) {
  const initialScope = targets.find((t) => t.scope === info?.scope)?.scope ?? targets.find((t) => t.scope === "environment")?.scope ?? targets[0].scope;
  const [scope, setScope] = useState(initialScope);
  const [value, setValue] = useState(info?.value ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(!info?.secret);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // The card mounts before the editor attaches it to the page, so focus a frame later.
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    // Dismiss on Escape or a click anywhere outside the card.
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const target = targets.find((t) => t.scope === scope) ?? targets[0];
  // A value written below the scope that currently defines the name would be ignored.
  const shadowedBy = info && PRECEDENCE.indexOf(info.scope) < PRECEDENCE.indexOf(scope) ? info.scope : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === "saving") return;
    setState("saving");
    setError(null);
    try {
      await target.write(name, value);
      setState("saved");
      setTimeout(() => onClose(), 650);
    } catch (err) {
      setState("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form
      ref={root}
      className="w-80 p-3 text-12"
      onSubmit={(e) => void submit(e)}
    >
      <Header name={name} chip={info ? <Chip tone={info.value ? "ok" : "warn"}>{SCOPE_LABEL[info.scope] ?? info.scope}</Chip> : <Chip tone="warn">New variable</Chip>} />
      <label className="mb-1 block text-11 font-medium tracking-wide text-muted uppercase" htmlFor="peek-scope">
        Scope
      </label>
      <select id="peek-scope" className="input h-8 text-12" value={scope} onChange={(e) => setScope(e.target.value as VariableTarget["scope"])}>
        {targets.map((t) => (
          <option key={t.scope} value={t.scope}>
            {t.label}
          </option>
        ))}
      </select>
      <label className="mt-2.5 mb-1 block text-11 font-medium tracking-wide text-muted uppercase" htmlFor="peek-value">
        Value
      </label>
      <div className="relative">
        <input
          id="peek-value"
          ref={input}
          className={clsx("input h-8 font-mono text-12", info?.secret && "pr-8")}
          type={reveal ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder="Value"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {info?.secret && (
          <button
            type="button"
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted hover:text-ink"
            aria-label={reveal ? "Hide value" : "Show value"}
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
          </button>
        )}
      </div>
      {shadowedBy && (
        <p className="mt-2 flex items-start gap-1.5 text-11 text-warning">
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
          <span>
            The {SCOPE_LABEL[shadowedBy].toLowerCase()} value takes precedence, so this one will not be used.
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-11 text-danger">
          <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
          <span className="break-words">Could not save: {error}</span>
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        {state === "saved" ? (
          <span className="mr-auto flex items-center gap-1 text-primary">
            <Check size={14} aria-hidden /> Saved to {SCOPE_LABEL[scope].toLowerCase()}
          </span>
        ) : (
          <span className="mr-auto text-11 text-muted">Enter to save, Esc to cancel</span>
        )}
        <button type="button" className="btn btn-cancel btn-sm" onClick={() => onClose()}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={state !== "idle"}>
          {state === "saving" ? <Loader2 size={13} className="spin" aria-hidden /> : null}
          Save
        </button>
      </div>
    </form>
  );
}

function Header({ name, chip }: { name: string; chip: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <span className="min-w-0 truncate font-mono font-semibold text-ink" title={name}>
        {name}
      </span>
      {chip}
    </div>
  );
}

function Chip({ tone, children }: { tone: "ok" | "warn"; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-11 font-medium",
        tone === "ok" ? "bg-var-ok-soft text-var-ok" : "bg-var-missing-soft text-var-missing",
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", tone === "ok" ? "bg-var-ok" : "bg-var-missing")} aria-hidden />
      {children}
    </span>
  );
}

function IconBtn({ label, icon: Icon, onClick }: { label: string; icon: typeof Copy; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-primary-soft hover:text-primary">
      <Icon size={14} aria-hidden />
    </button>
  );
}
