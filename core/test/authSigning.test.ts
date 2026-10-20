import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { awsScopeFromHost, digestAuthorization, parseDigestChallenge, signAwsV4 } from "../src/authSigning.js";
import { defaultAuth, newRequest } from "../src/models.js";
import { execute } from "../src/requestExecutor.js";
import { readAuth, writeAuth } from "../src/yamlDtos.js";

// Credentials and expected signatures from AWS's published SigV4 test suite.
const aws = { accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "", region: "us-east-1", service: "service" };
const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
const authOf = (list: { key: string; value: string }[]) => list.find((h) => h.key === "Authorization")?.value;

describe("AWS Signature Version 4", () => {
  it("matches the get-vanilla vector", () => {
    const added = signAwsV4({ method: "GET", url: "https://example.amazonaws.com/", headers: [], body: "", aws, now });
    expect(added.find((h) => h.key === "X-Amz-Date")?.value).toBe("20150830T123600Z");
    expect(authOf(added)).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("matches the get-vanilla-query-order-key-case vector", () => {
    const added = signAwsV4({ method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", headers: [], body: "", aws, now });
    expect(authOf(added)).toMatch(/Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
  });

  it("adds the session token and reads region and service from AWS hosts", () => {
    const added = signAwsV4({ method: "GET", url: "https://s3.eu-west-1.amazonaws.com/b/k", headers: [], body: "", aws: { ...aws, region: "", service: "", sessionToken: "tok" }, now });
    expect(added.map((h) => h.key)).toEqual(["X-Amz-Date", "X-Amz-Security-Token", "X-Amz-Content-Sha256", "Authorization"]);
    expect(authOf(added)).toContain("/20150830/eu-west-1/s3/aws4_request");
    expect(awsScopeFromHost("dynamodb.us-west-2.amazonaws.com")).toEqual({ service: "dynamodb", region: "us-west-2" });
  });

  it("encodes S3 key characters once, however the URL wrote them", () => {
    const sign = (url: string) => authOf(signAwsV4({ method: "GET", url, headers: [], body: "", aws: { ...aws, region: "us-east-1", service: "s3" }, now }));
    const raw = sign("https://bucket.s3.amazonaws.com/a+b/2024-01-01T10:00:00.json");
    expect(raw).toBe(sign("https://bucket.s3.amazonaws.com/a%2Bb/2024-01-01T10%3A00%3A00.json"));
    // Not the signature of the path left as the URL parser keeps it.
    expect(raw).not.toBe(sign("https://bucket.s3.amazonaws.com/ab/2024-01-01T10-00-00.json"));
  });

  it("is stored and read back in the workspace YAML shape", () => {
    const a = { ...defaultAuth("awsv4"), aws: { ...aws, sessionToken: "t" } };
    expect(readAuth(writeAuth(a)).aws).toEqual(a.aws);
  });
});

describe("Digest", () => {
  it("answers the RFC 2617 example", () => {
    const c = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
    const header = digestAuthorization(c, { username: "Mufasa", password: "Circle Of Life", method: "GET", uri: "/dir/index.html", cnonce: "0a4f113b", nc: 1 });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain("qop=auth, nc=00000001");
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it("answers an auth-int only challenge with the body hashed in", () => {
    const md5 = (s: string) => createHash("md5").update(s).digest("hex");
    const c = parseDigestChallenge('Digest realm="r", qop="auth-int", nonce="n1"')!;
    const header = digestAuthorization(c, { username: "u", password: "p", method: "POST", uri: "/x", cnonce: "c", nc: 1, body: '{"a":1}' });
    const ha1 = md5("u:r:p");
    const ha2 = md5(`POST:/x:${md5('{"a":1}')}`);
    expect(header).toContain("qop=auth-int");
    expect(header).toContain(`response="${md5(`${ha1}:n1:00000001:c:auth-int:${ha2}`)}"`);
  });

  it("ignores other schemes in the header", () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeUndefined();
    expect(parseDigestChallenge('Basic realm="a", Digest realm="b", nonce="n"')).toMatchObject({ realm: "b", nonce: "n" });
  });

  describe("against a server", () => {
    let server: Server;
    let base: string;
    let attempts: (string | undefined)[];
    beforeEach(async () => {
      attempts = [];
      const md5 = (s: string) => createHash("md5").update(s).digest("hex");
      server = createServer((req, res) => {
        const header = req.headers.authorization;
        attempts.push(header);
        const field = (k: string) => new RegExp(`${k}="?([^",]+)"?`).exec(header ?? "")?.[1];
        const ha1 = md5("ada:yamlet:pw");
        const ha2 = md5(`${req.method}:${field("uri")}`);
        const expected = md5(`${ha1}:abc123:${field("nc")}:${field("cnonce")}:auth:${ha2}`);
        if (header?.startsWith("Digest ") && field("response") === expected) return res.end("welcome");
        res.writeHead(401, { "www-authenticate": 'Digest realm="yamlet", qop="auth", nonce="abc123", algorithm=MD5' }).end("no");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });

    it("signs in after the challenge", async () => {
      const auth = { ...defaultAuth("digest"), username: "ada", password: "pw" };
      const { response } = await execute({ request: newRequest({ url: `${base}/secret?x=1`, auth }), globals: [], workspaceRoot: os.tmpdir() });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("welcome");
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toContain('uri="/secret?x=1"');
    });

    it("shows the 401 when the password is wrong", async () => {
      const auth = { ...defaultAuth("digest"), username: "ada", password: "nope" };
      const { response } = await execute({ request: newRequest({ url: `${base}/secret`, auth }), globals: [], workspaceRoot: os.tmpdir() });
      expect(response.statusCode).toBe(401);
    });
  });
});
