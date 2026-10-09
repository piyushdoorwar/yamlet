import { newCollection, newRequest, type YamletRequest, type YamletWorkspace } from "@core/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveRequest = vi.fn();
vi.mock("../src/lib/api", async (orig) => {
  const actual = await orig<typeof import("../src/lib/api")>();
  return { ...actual, api: { ...actual.api, saveRequest: (r: YamletRequest) => saveRequest(r) } };
});

const { useStore } = await import("../src/lib/store");

function workspaceWith(request: YamletRequest): YamletWorkspace {
  return {
    name: "t",
    rootPath: "/t",
    collectionsPath: "/t/collections",
    environmentsPath: "/t/environments",
    globalsPath: "/t/globals",
    collections: [newCollection({ requests: [request] })],
    environments: [],
    globals: [],
  };
}

describe("request autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    saveRequest.mockReset();
  });

  it("does not let an older save's response replace newer edits", async () => {
    const request = newRequest({ name: "r" });
    useStore.getState().loadWorkspace(workspaceWith(request));
    const pending: ((v: unknown) => void)[] = [];
    saveRequest.mockImplementation((r: YamletRequest) => new Promise((res) => pending.push(() => res({ workspace: workspaceWith(r) }))));
    const setClientId = (clientId: string) =>
      useStore.getState().updateDraft(request.id, (r) => ({ ...r, auth: { ...r.auth, type: "oauth2", oauth2: { ...r.auth.oauth2, clientId } } }));

    setClientId("abc");
    await vi.advanceTimersByTimeAsync(600);
    expect(saveRequest).toHaveBeenCalledTimes(1);

    setClientId("abcdef");
    const second = useStore.getState().saveNow(request.id);

    // The first save answers with the old client ID while the second is queued.
    pending[0](undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().drafts[request.id].auth.oauth2.clientId).toBe("abcdef");

    // The second save runs after the first and carries the newest draft.
    expect(saveRequest).toHaveBeenCalledTimes(2);
    expect(saveRequest.mock.calls[1][0].auth.oauth2.clientId).toBe("abcdef");
    pending[1](undefined);
    await second;
    expect(useStore.getState().drafts[request.id].auth.oauth2.clientId).toBe("abcdef");
    expect(useStore.getState().saveState[request.id]).toBe("saved");
  });

  it("records why a save failed and keeps the draft for a retry", async () => {
    const request = newRequest({ name: "r" });
    useStore.getState().loadWorkspace(workspaceWith(request));
    saveRequest.mockRejectedValueOnce(new Error("Permission denied"));

    useStore.getState().updateDraft(request.id, (r) => ({ ...r, url: "https://changed.test" }));
    await useStore.getState().saveNow(request.id);
    expect(useStore.getState().saveState[request.id]).toBe("error");
    expect(useStore.getState().saveErrors[request.id]).toBe("Permission denied");

    // Refreshing the tree must not discard the unsaved draft.
    useStore.getState().applyWorkspace(workspaceWith(request));
    expect(useStore.getState().drafts[request.id].url).toBe("https://changed.test");

    saveRequest.mockImplementation(async (r: YamletRequest) => ({ workspace: workspaceWith(r) }));
    await useStore.getState().saveNow(request.id);
    expect(saveRequest).toHaveBeenLastCalledWith(expect.objectContaining({ url: "https://changed.test" }));
    expect(useStore.getState().saveErrors[request.id]).toBeUndefined();
  });
});
