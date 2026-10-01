import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

/**
 * Local editable copy of `source`, written back with `save` shortly after edits
 * stop. Re-syncs from `source` when it changes and nothing is pending.
 */
export function useAutosave<T>(source: T, save: (value: T) => Promise<void>, delay = 500) {
  const [value, setValue] = useState(source);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!pending.current) {
      setValue(source);
      latest.current = source;
    }
  }, [source]);

  const flush = async () => {
    if (!pending.current) return;
    clearTimeout(pending.current);
    pending.current = null;
    setStatus("saving");
    try {
      await saveRef.current(latest.current);
      setStatus("saved");
      setError(null);
    } catch (err) {
      setStatus("error");
      setError(errorMessage(err));
    }
  };

  useEffect(
    () => () => {
      void flush();
    },
    // Flush once on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const update = (next: T | ((prev: T) => T)) => {
    const v = typeof next === "function" ? (next as (p: T) => T)(latest.current) : next;
    latest.current = v;
    setValue(v);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void flush(), delay);
  };

  return { value, update, status, error, flush };
}
