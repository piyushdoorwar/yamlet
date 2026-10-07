// Talks to the Yamlet Interceptor extension through its bridge script
// (extension/bridge.js), which relays window messages on localhost pages. The
// extension uses it to pair in one click and to re-pair on its own when this server
// has forgotten its pairing (for example after the /data volume was replaced).
import { useEffect, useState } from "react";
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
const cancelWatchers = new Set<() => void>();
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
  } else if (type === "pairCancelled") {
    for (const watch of cancelWatchers) watch();
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

/** Calls `fn` when the user cancels or closes the extension's confirmation window. */
export function onPairCancelled(fn: () => void): () => void {
  cancelWatchers.add(fn);
  return () => void cancelWatchers.delete(fn);
}
