import { MockAgent } from "undici";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultOAuth2, type OAuth2Config } from "../src/models.js";
import { buildAuthorizationUrl, fetchToken, OAuth2Error } from "../src/oauth2.js";

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});

const cfg = (patch: Partial<OAuth2Config> = {}): OAuth2Config => ({
  ...defaultOAuth2(),
  accessTokenUrl: "https://auth.test/token",
  clientId: "cid",
  clientSecret: "secret",
  ...patch,
});
const same = (s: string) => s;

async function failure(p: Promise<unknown>): Promise<OAuth2Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OAuth2Error);
  return err as OAuth2Error;
}

describe("fetchToken errors", () => {
  it("reports settings problems before sending anything", async () => {
    expect((await failure(fetchToken(cfg({ accessTokenUrl: "" }), same, { dispatcher: agent }))).message).toBe("Token URL is not set");
    const undefinedVar = await failure(fetchToken(cfg({ accessTokenUrl: "{{authHost}}/token" }), same, { dispatcher: agent }));
    expect(undefinedVar.kind).toBe("config");
    expect(undefinedVar.message).toContain("{{authHost}}");
    expect((await failure(fetchToken(cfg({ accessTokenUrl: "auth.test/token" }), same, { dispatcher: agent }))).message).toContain("not a valid URL");
  });

  it("explains provider errors from the RFC 6749 error body", async () => {
    agent
      .get("https://auth.test")
      .intercept({ path: "/token", method: "POST" })
      .reply(401, JSON.stringify({ error: "invalid_client", error_description: "Client authentication failed" }), { headers: { "content-type": "application/json" } });
    const err = await failure(fetchToken(cfg(), same, { dispatcher: agent }));
    expect(err.kind).toBe("provider");
    expect(err.status).toBe(401);
    expect(err.message).toContain("401: invalid_client: Client authentication failed");
    expect(err.message).toContain("client ID and secret");
  });

  it("names the host when the token URL cannot be reached", async () => {
    agent
      .get("https://auth.test")
      .intercept({ path: "/token", method: "POST" })
      .replyWithError(Object.assign(new Error("getaddrinfo ENOTFOUND auth.test"), { code: "ENOTFOUND" }));
    const err = await failure(fetchToken(cfg(), same, { dispatcher: agent }));
    expect(err.kind).toBe("network");
    expect(err.message).toContain("auth.test");
  });

  it("returns the token on success", async () => {
    agent
      .get("https://auth.test")
      .intercept({ path: "/token", method: "POST" })
      .reply(200, JSON.stringify({ access_token: "tok", expires_in: 60 }), { headers: { "content-type": "application/json" } });
    await expect(fetchToken(cfg(), same, { dispatcher: agent })).resolves.toMatchObject({ accessToken: "tok", expiresIn: 60 });
  });
});

describe("buildAuthorizationUrl", () => {
  it("rejects a missing auth URL as a settings problem", () => {
    expect(() => buildAuthorizationUrl(cfg({ authUrl: "" }), same, { state: "s", redirectUri: "http://localhost/cb" })).toThrow(OAuth2Error);
  });
});
