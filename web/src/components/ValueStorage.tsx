import type { Variable } from "@core/models";
import clsx from "clsx";
import { FileText, HardDrive } from "lucide-react";
import { useState } from "react";
import { useDialogs } from "./Dialogs";

export type StorageMode = "file" | "local" | "mixed";

/** `v` with `local` set or removed (a file-stored variable carries no flag). */
export function withLocal(v: Variable, local: boolean): Variable {
  const { local: _drop, ...rest } = v;
  return local ? { ...rest, local: true } : rest;
}

/**
 * Where a variable list keeps its values: every row in the file, every row local, or mixed
 * (set per row). New rows follow the list; an empty list remembers the choice for its first row.
 */
export function useValueStorage(vars: Variable[], onChange: (vars: Variable[]) => void) {
  const [preferLocal, setPreferLocal] = useState(false);
  const mode: StorageMode =
    vars.length === 0 ? (preferLocal ? "local" : "file") : vars.every((v) => v.local) ? "local" : vars.some((v) => v.local) ? "mixed" : "file";
  const setMode = (next: "file" | "local") => {
    setPreferLocal(next === "local");
    onChange(vars.map((v) => withLocal(v, next === "local")));
  };
  const blank = (): Variable => withLocal({ key: "", value: "", enabled: true }, mode === "local");
  return { mode, setMode, blank };
}

const OPTIONS = [
  { id: "file", label: "File", icon: FileText, title: "Save values in the YAML file (shared through Git)" },
  { id: "local", label: "Local", icon: HardDrive, title: "Keep values on this machine only; the YAML file gets the keys with blank values" },
] as const;

/** File / Local switch for a variable list, with a way to forget the stored local values. */
export function ValueStorageSwitch({ vars, onChange, mode, setMode }: { vars: Variable[]; onChange: (vars: Variable[]) => void } & ReturnType<typeof useValueStorage>) {
  const { confirm } = useDialogs();
  const storedLocally = vars.filter((v) => v.local && v.value).length;
  const clear = async () => {
    const ok = await confirm({
      title: "Clear local values",
      message: `Remove the ${storedLocally === 1 ? "value" : `${storedLocally} values`} stored on this machine? The variables stay, with blank values.`,
      action: "Clear",
      danger: true,
    });
    if (ok) onChange(vars.map((v) => (v.local ? { ...v, value: "" } : v)));
  };
  return (
    <div className="flex items-center gap-2">
      {storedLocally > 0 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void clear()}>
          Clear local values
        </button>
      )}
      <span className="text-12 text-muted">{mode === "mixed" ? "Values: per variable" : "Values"}</span>
      <div role="radiogroup" aria-label="Where values are saved" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
        {OPTIONS.map(({ id, label, icon: Icon, title }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            title={title}
            onClick={() => setMode(id)}
            className={clsx(
              "flex items-center gap-1 rounded-md px-2.5 py-1 text-12 whitespace-nowrap transition-colors",
              mode === id ? "bg-primary text-white" : "text-grey hover:bg-line-soft",
            )}
          >
            <Icon size={12} aria-hidden /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export const LOCAL_VALUES_NOTE =
  "Local values stay in Yamlet's data folder on this machine (the /data volume in Docker), so they survive restarts and upgrades. The YAML file keeps the key with a blank value, so they never reach Git. Secret only masks a value on screen.";
