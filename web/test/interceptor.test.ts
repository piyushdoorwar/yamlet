import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { sendPairCode, startInterceptorBridge, useInterceptorExtension } from "../src/lib/interceptor";

/** Plays the extension's bridge script: posts on this window from this origin. */
function fromExtension(message: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent("message", { data: { source: "yamlet-interceptor", ...message }, origin: location.origin, source: window }));
}

function pageMessages() {
  const seen: Record<string, unknown>[] = [];
  const listener = (event: MessageEvent) => {
    if (event.data?.source === "yamlet") seen.push(event.data);
  };
  window.addEventListener("message", listener);
  return { seen, stop: () => window.removeEventListener("message", listener) };
}

describe("interceptor bridge", () => {
  startInterceptorBridge();

  it("detects the extension, hands it pairing codes and answers its code requests", async () => {
    const { result } = renderHook(() => useInterceptorExtension());
    expect(result.current).toBe(false);
    act(() => fromExtension({ type: "pong" }));
    expect(result.current).toBe(true);

    const messages = pageMessages();
    const start = vi.spyOn(api, "interceptorPairStart").mockResolvedValue({ code: "fresh", expiresInSeconds: 300 });
    fromExtension({ type: "codeRequest", id: "r1" });
    await waitFor(() => expect(messages.seen).toContainEqual({ source: "yamlet", type: "code", id: "r1", code: "fresh" }));
    expect(start).toHaveBeenCalledOnce();

    sendPairCode("abc");
    await waitFor(() => expect(messages.seen).toContainEqual({ source: "yamlet", type: "pair", code: "abc" }));
    messages.stop();
    start.mockRestore();
  });

  it("ignores messages from other windows or origins", async () => {
    const start = vi.spyOn(api, "interceptorPairStart").mockResolvedValue({ code: "x", expiresInSeconds: 300 });
    window.dispatchEvent(new MessageEvent("message", { data: { source: "yamlet-interceptor", type: "codeRequest", id: "r2" }, origin: "http://evil.test", source: window }));
    window.dispatchEvent(new MessageEvent("message", { data: { source: "yamlet-interceptor", type: "codeRequest", id: "r3" }, origin: location.origin, source: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });
});
