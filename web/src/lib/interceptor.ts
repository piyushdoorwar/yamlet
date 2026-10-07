// Talks to the Yamlet Interceptor extension through its bridge script
// (extension/bridge.js), which relays window messages on localhost pages. The
// extension uses it to pair in one click and to re-pair on its own when this server
// has forgotten its pairing (for example after the /data volume was replaced).
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, errorMessage } from "./api";

const PAGE = "yamlet";
const EXTENSION = "yamlet-interceptor";

interface BridgeMessage {
  source?: unknown;
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  pending?: unknown;
  error?: unknown;
}

/** What the extension did with a pairing code. */
export type PairOutcome =
  | { status: "paired" } // the address was already trusted
  | { status: "confirm" } // waiting for the user in the extension's window
  | { status: "failed"; error: string };

/** How long to wait for the extension to answer a pairing code. */
const PAIR_ANSWER_MS = 10_000;

let present = false;
const watchers = new Set<(present: boolean) => void>();
/** How the extension's confirmation window ended. */
export type PairWindowOutcome = { status: "cancelled" } | { status: "paired" } | { status: "failed"; error: string };
const windowWatchers = new Set<(outcome: PairWindowOutcome) => void>();
let answerPair: ((outcome: PairOutcome) => void) | null = null;

function post(message: Record<string, unknown>): void {
  window.postMessage({ source: PAGE, ...message }, location.origin);
}

function onMessage(event: MessageEvent<BridgeMessage>): void {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== EXTENSION) return;
  const { type, id } = event.data;
  if (type === "pong" && !present) {
    present = true;
    for (const watch of watchers) watch(true);
  } else if (type === "pairResult") {
    const { ok, pending, error } = event.data;
    answerPair?.(ok ? { status: pending ? "confirm" : "paired" } : { status: "failed", error: typeof error === "string" ? error : "The extension could not pair." });
  } else if (type === "pairCancelled" || type === "pairDone" || type === "pairFailed") {
    const { error } = event.data;
    const outcome: PairWindowOutcome =
      type === "pairCancelled" ? { status: "cancelled" } : type === "pairDone" ? { status: "paired" } : { status: "failed", error: typeof error === "string" ? error : "Pairing failed." };
    for (const watch of windowWatchers) watch(outcome);
  } else if (type === "codeRequest" && typeof id === "string") {
    void api.interceptorPairStart().then(
      ({ code }) => post({ type: "code", id, code }),
      (err: unknown) => post({ type: "code", id, error: errorMessage(err) }),
    );
  }
}

/** Listens for the extension for the lifetime of the page. */
export function startInterceptorBridge(): void {
  window.addEventListener("message", onMessage);
  post({ type: "ping" });
}

/** True once the extension's bridge has answered on this page. */
export function useInterceptorExtension(): boolean {
  const [value, setValue] = useState(present);
  useEffect(() => {
    watchers.add(setValue);
    setValue(present);
    return () => void watchers.delete(setValue);
  }, []);
  return value;
}

/** Hands a pairing code to the extension, which pairs or asks the user to confirm. */
export function sendPairCode(code: string): Promise<PairOutcome> {
  answerPair?.({ status: "failed", error: "Superseded by a newer pairing request." });
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ status: "failed", error: "The extension did not answer." }), PAIR_ANSWER_MS);
    const finish = (outcome: PairOutcome) => {
      clearTimeout(timer);
      answerPair = null;
      resolve(outcome);
    };
    answerPair = finish;
    post({ type: "pair", code });
  });
}

/** Calls `fn` when the extension's confirmation window is confirmed, fails, or is cancelled or closed. */
export function onPairWindow(fn: (outcome: PairWindowOutcome) => void): () => void {
  windowWatchers.add(fn);
  return () => void windowWatchers.delete(fn);
}

/** Whether an extension is paired with the open workspace (null until known). */
export const useInterceptorPaired = create<{ paired: boolean | null; pairedAt: string | null }>(() => ({ paired: null, pairedAt: null }));

/** Asks the server again; the footer and the Cookies modal both read the result. */
export async function refreshInterceptorStatus(): Promise<boolean> {
  try {
    const { paired, pairedAt } = await api.interceptorStatus();
    useInterceptorPaired.setState({ paired, pairedAt });
    return paired;
  } catch {
    return useInterceptorPaired.getState().paired ?? false;
  }
}
