import type { KeyValue } from "@core/models";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { KeyValueTable } from "../src/components/KeyValueTable";
import { StatusPill, statusCategory } from "../src/components/Labels";

function Harness({ initial }: { initial: KeyValue[] }) {
  const [rows, setRows] = useState(initial);
  return (
    <>
      <KeyValueTable<KeyValue> rows={rows} onChange={setRows} blank={() => ({ key: "", value: "", enabled: true })} />
      <output data-testid="rows">{JSON.stringify(rows)}</output>
    </>
  );
}

describe("KeyValueTable", () => {
  it("adds a row when typing into the trailing blank row", async () => {
    render(<Harness initial={[]} />);
    await userEvent.type(screen.getAllByLabelText("Key")[0], "Accept");
    expect(JSON.parse(screen.getByTestId("rows").textContent!)).toEqual([{ key: "Accept", value: "", enabled: true }]);
    expect(screen.getAllByLabelText("Key")).toHaveLength(2);
  });

  it("toggles and deletes rows", async () => {
    render(<Harness initial={[{ key: "a", value: "1", enabled: true }]} />);
    await userEvent.click(screen.getByLabelText("Enable a"));
    expect(JSON.parse(screen.getByTestId("rows").textContent!)[0].enabled).toBe(false);
    await userEvent.click(screen.getByLabelText("Delete a"));
    expect(JSON.parse(screen.getByTestId("rows").textContent!)).toEqual([]);
  });

  it("edits rows in bulk", async () => {
    render(<Harness initial={[{ key: "a", value: "1", enabled: true }]} />);
    await userEvent.click(screen.getByText("Bulk edit"));
    const box = screen.getByLabelText("Bulk edit");
    await userEvent.clear(box);
    await userEvent.type(box, "x: 1{enter}// y: 2");
    expect(JSON.parse(screen.getByTestId("rows").textContent!)).toEqual([
      { key: "x", value: "1", enabled: true },
      { key: "y", value: "2", enabled: false },
    ]);
  });
});

describe("labels", () => {
  it("maps statuses to categories", () => {
    expect([200, 301, 404, 503, 0].map(statusCategory)).toEqual(["success", "redirect", "client", "server", "none"]);
    render(<StatusPill status={201} text="Created" />);
    expect(screen.getByText("201 Created")).toBeInTheDocument();
  });
});

describe("App boot", () => {
  it("shows the workspace picker when nothing can be opened", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/info") return json(200, { version: "test", defaultWorkspace: "/workspace", browseRoot: "/workspace", inContainer: true, oauthCallbackUrl: "" });
      if (url.startsWith("/api/workspace/open")) return json(404, { error: "No Yamlet workspace" });
      if (url.startsWith("/api/fs/list")) return json(200, { path: "/workspace", parent: null, isWorkspace: false, entries: [] });
      return json(404, { error: "nope" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText("Open a workspace")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /Make this a workspace/ })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/open", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });
});
