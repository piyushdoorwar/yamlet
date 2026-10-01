import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  action: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  action?: string;
  placeholder?: string;
}

interface Dialogs {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<Dialogs | null>(null);

type Open = { kind: "confirm"; opts: ConfirmOptions } | { kind: "prompt"; opts: PromptOptions };

/** `await confirm({...})` and `await prompt({...})`, one modal for the whole app. */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [value, setValue] = useState("");
  const resolver = useRef<(v: unknown) => void>(undefined);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setOpen({ kind: "confirm", opts });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve as (v: unknown) => void;
    });
  }, []);

  const prompt = useCallback((opts: PromptOptions) => {
    setValue(opts.initial ?? "");
    setOpen({ kind: "prompt", opts });
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve as (v: unknown) => void;
    });
  }, []);

  const close = (result: unknown) => {
    resolver.current?.(result);
    resolver.current = undefined;
    setOpen(null);
  };

  const dialogs = useRef<Dialogs>({ confirm, prompt });

  return (
    <DialogContext.Provider value={dialogs.current}>
      {children}
      {open?.kind === "confirm" && (
        <Modal
          title={open.opts.title}
          onClose={() => close(false)}
          footer={
            <>
              <Button variant="cancel" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant={open.opts.danger ? "delete" : "primary"} onClick={() => close(true)}>
                {open.opts.action}
              </Button>
            </>
          }
        >
          {open.opts.message}
        </Modal>
      )}
      {open?.kind === "prompt" && (
        <Modal
          title={open.opts.title}
          onClose={() => close(null)}
          footer={
            <>
              <Button variant="cancel" onClick={() => close(null)}>
                Cancel
              </Button>
              <Button disabled={!value.trim()} onClick={() => close(value.trim())}>
                {open.opts.action ?? "Save"}
              </Button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) close(value.trim());
            }}
          >
            {open.opts.label && (
              <label className="label" htmlFor="prompt-input">
                {open.opts.label}
              </label>
            )}
            <input
              id="prompt-input"
              className="input"
              autoFocus
              value={value}
              placeholder={open.opts.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.target.select()}
            />
          </form>
        </Modal>
      )}
    </DialogContext.Provider>
  );
}

export function useDialogs(): Dialogs {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs must be used inside <DialogProvider>");
  return ctx;
}
