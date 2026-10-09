import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutosave } from "../src/lib/useAutosave";
import { upsertVariable } from "../src/lib/variables";

describe("useAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps newer edits when an older save's echo arrives", async () => {
    const resolvers: (() => void)[] = [];
    const saved: string[] = [];
    const save = vi.fn((v: string) => {
      saved.push(v);
      return new Promise<void>((r) => resolvers.push(r));
    });
    const { result, rerender } = renderHook(({ source }) => useAutosave(source, save, 100), { initialProps: { source: "a" } });

    act(() => result.current.update("ab"));
    await act(async () => void vi.advanceTimersByTime(100));
    expect(saved).toEqual(["ab"]);

    // More typing while the first save is still in flight.
    act(() => result.current.update("abc"));
    await act(async () => void vi.advanceTimersByTime(100));
    // The second save waits for the first instead of racing it.
    expect(saved).toEqual(["ab"]);

    // The first save's echo comes back from the server.
    rerender({ source: "ab" });
    expect(result.current.value).toBe("abc");

    await act(async () => resolvers[0]());
    expect(saved).toEqual(["ab", "abc"]);
    await act(async () => resolvers[1]());
    expect(result.current.value).toBe("abc");
    expect(result.current.status).toBe("saved");
  });

  it("keeps edits after a failed save and retries them", async () => {
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error("disk full");
    });
    const { result, rerender } = renderHook(({ source }) => useAutosave(source, save, 100), { initialProps: { source: "a" } });

    act(() => result.current.update("changed"));
    await act(async () => void vi.advanceTimersByTime(100));
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("disk full");

    // An unrelated refresh of the source must not wipe the unsaved edit.
    rerender({ source: "a2" });
    expect(result.current.value).toBe("changed");

    fail = false;
    await act(async () => result.current.retry());
    expect(save).toHaveBeenLastCalledWith("changed");
    expect(result.current.status).toBe("saved");
  });
});

describe("upsertVariable", () => {
  it("updates an existing key (case-insensitively) and enables it", () => {
    const vars = [{ key: "Token", value: "old", enabled: false }];
    expect(upsertVariable(vars, "token", "new")).toEqual([{ key: "Token", value: "new", enabled: true }]);
  });

  it("appends a missing key", () => {
    expect(upsertVariable([], "host", "x")).toEqual([{ key: "host", value: "x", enabled: true }]);
  });
});
