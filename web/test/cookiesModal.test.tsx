import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toast";
import { api } from "../src/lib/api";
import { startInterceptorBridge } from "../src/lib/interceptor";
import { CookiesModal } from "../src/modals/CookiesModal";

/** Plays the extension's bridge script: posts on this window from this origin. */
function fromExtension(message: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent("message", { data: { source: "yamlet-interceptor", ...message }, origin: location.origin, source: window }));
}

/** Answers the page's next pairing request the way the extension would. */
function extensionAnswers(answer: Record<string, unknown>) {
  const listener = (event: MessageEvent) => {
    if (event.data?.source !== "yamlet" || event.data.type !== "pair") return;
    window.removeEventListener("message", listener);
    fromExtension({ type: "pairResult", ...answer });
  };
  window.addEventListener("message", listener);
}

function setup(paired = false) {
  vi.spyOn(api, "cookies").mockResolvedValue([]);
  vi.spyOn(api, "interceptorStatus").mockResolvedValue({ paired });
  vi.spyOn(api, "interceptorPairStart").mockResolvedValue({ code: "one-time-code", expiresInSeconds: 300 });
  render(
    <ToastProvider>
      <CookiesModal onClose={() => {}} />
    </ToastProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

// The bridge remembers the extension once it answers, so the no-extension case runs first.
describe("Cookies modal pairing", () => {
  startInterceptorBridge();

  it("shows the code straight away when the extension is not on the page", async () => {
    setup();
    expect(await screen.findByText(/Extension not detected/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Pair with code" }));
    expect(await screen.findByText("one-time-code")).toBeTruthy();
  });

  it("waits for the confirmation window without showing the code", async () => {
    act(() => fromExtension({ type: "pong" }));
    setup();
    extensionAnswers({ ok: true, pending: true });
    await userEvent.click(await screen.findByRole("button", { name: "Pair extension" }));
    expect(await screen.findByText("Confirm in the Yamlet Interceptor window.")).toBeTruthy();
    expect(screen.queryByText("one-time-code")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Use a code instead" }));
    expect(screen.getByText("one-time-code")).toBeTruthy();
  });

  it("returns to idle when the confirmation window is cancelled", async () => {
    setup();
    extensionAnswers({ ok: true, pending: true });
    await userEvent.click(await screen.findByRole("button", { name: "Pair extension" }));
    await screen.findByText("Confirm in the Yamlet Interceptor window.");
    act(() => fromExtension({ type: "pairCancelled" }));
    expect(await screen.findByText("Pairing cancelled in the extension.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair extension" })).toBeTruthy();
  });

  it("pairs at once with an address the extension already trusts", async () => {
    setup();
    extensionAnswers({ ok: true, pending: false });
    await userEvent.click(await screen.findByRole("button", { name: "Pair extension" }));
    await waitFor(() => expect(screen.getByText("Paired")).toBeTruthy());
    expect(screen.queryByText("one-time-code")).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect extensions" })).toBeTruthy();
  });

  it("offers the code when the extension reports an error", async () => {
    setup();
    extensionAnswers({ ok: false, error: "Yamlet is not reachable." });
    await userEvent.click(await screen.findByRole("button", { name: "Pair extension" }));
    expect(await screen.findByText("Yamlet is not reachable.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use a code instead" }));
    expect(screen.getByText("one-time-code")).toBeTruthy();
  });
});
