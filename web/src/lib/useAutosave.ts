import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

/**
 * Local editable copy of `source`, written back with `save` shortly after edits
 * stop. Saves run one at a time, in order. The copy re-syncs from `source` only when
 * nothing is pending, in flight or failed, so a slow save's echo never overwrites
 * newer edits and a failed save never discards them.
 */
export function useAutosave<T>(source: T, save: (value: T) => Promise<void>, delay = 500) {
  const [value, setValue] = useState(source);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<void> | null>(null);
  const failed = useRef(false);
  const latest = useRef(value);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!pending.current && !queue.current && !failed.current) {
      setValue(source);
      latest.current = source;
    }
  }, [source]);

  const flush = useCallback(async () => {
    if (!pending.current && !failed.current) return queue.current ?? undefined;
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    failed.current = false;
    const run = async () => {
      setStatus("saving");
      try {
        await saveRef.current(latest.current);
        setStatus("saved");
        setError(null);
      } catch (err) {
        failed.current = true;
        setStatus("error");
        setError(errorMessage(err));
      }
    };
    const queued: Promise<void> = (queue.current ?? Promise.resolve()).then(run);
    queue.current = queued;
    try {
      await queued;
    } finally {
      if (queue.current === queued) queue.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  const update = (next: T | ((prev: T) => T)) => {
    const v = typeof next === "function" ? (next as (p: T) => T)(latest.current) : next;
    latest.current = v;
    setValue(v);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void flush(), delay);
  };

  /** Saves again after a failure (or saves pending edits now). */
  const retry = useCallback(() => void flush(), [flush]);

  return { value, update, status, error, flush, retry };
}
