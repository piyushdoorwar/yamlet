import { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { isNewer, UpdateChecker } from "../src/updates.js";

describe("isNewer", () => {
  it("compares major, minor and patch numerically", () => {
    expect(isNewer("1.10.0", "1.9.3")).toBe(true);
    expect(isNewer("v2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
    expect(isNewer("1.2.2", "1.2.3")).toBe(false);
  });

  it("treats a release as newer than its own pre-releases", () => {
    expect(isNewer("1.3.0", "1.3.0-rc.2")).toBe(true);
    expect(isNewer("1.3.0-rc.10", "1.3.0-rc.2")).toBe(true);
    expect(isNewer("1.3.0-rc.1", "1.3.0")).toBe(false);
  });

  it("never reports an update for unparseable versions", () => {
    expect(isNewer("1.0.0", "dev")).toBe(false);
  });
});

function github(agent: MockAgent, tag: string, times = 1) {
  agent
    .get("https://api.github.com")
    .intercept({ path: "/repos/piyushdoorwar/yamlet/releases/latest", method: "GET" })
    .reply(200, { tag_name: tag, html_url: `https://github.com/piyushdoorwar/yamlet/releases/tag/${tag}` }, { headers: { "content-type": "application/json" } })
    .times(times);
}

describe("UpdateChecker", () => {
  it("reports a newer release and caches the answer for an hour", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    github(agent, "v1.4.0");
    const checker = new UpdateChecker("1.3.2", true, agent);
    const first = await checker.get();
    expect(first).toMatchObject({ available: true, latest: "1.4.0", current: "1.3.2" });
    // A second call within the hour must not hit GitHub again (the mock allows one reply).
    await expect(checker.get()).resolves.toMatchObject({ available: true });
  });

  it("does nothing when disabled", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    await expect(new UpdateChecker("1.0.0", false, agent).get(true)).resolves.toEqual({ enabled: false, current: "1.0.0", available: false });
  });

  it("keeps the last result when a check fails", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    github(agent, "v1.4.0");
    const checker = new UpdateChecker("1.3.2", true, agent);
    await checker.get();
    const after = await checker.get(true);
    expect(after.available).toBe(true);
    expect(after.error).toBeTruthy();
  });
});
