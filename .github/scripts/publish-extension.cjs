// Uploads the packaged extension to the Chrome Web Store and submits it for review.
//   node .github/scripts/publish-extension.cjs dist/yamlet-interceptor-1.2.3.zip v1.2.3
// Skips (with a notice in the run summary) when the store already has this version or
// newer, or when extension/ is unchanged since the tag of the version in the store.
// The comparison is against the store itself, so a tag that never reached the store
// can't hide later changes.
// Env: CWS_SERVICE_ACCOUNT_KEY (the service account's JSON key), CWS_PUBLISHER_ID,
// CWS_EXTENSION_ID. The service account must be added in the store's Developer
// Dashboard; it needs no Google Cloud roles.
const { execFileSync } = require("node:child_process");
const { createSign } = require("node:crypto");
const { appendFileSync, readFileSync } = require("node:fs");

const API = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/** Exchanges a JWT signed with the service account key for an access token. */
async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const response = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Token request failed (${response.status}): ${JSON.stringify(body)}`);
  return body.access_token;
}

async function call(token, method, url, init = {}) {
  const response = await fetch(url, { method, ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

/** Logs a notice that also shows on the run's summary page. */
function notice(message) {
  console.log(`::notice title=Chrome Web Store::${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Chrome Web Store:** ${message}\n`);
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** The newest version in the store, counting one still in review. */
function storeVersion(status) {
  const versions = [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]
    .flatMap((revision) => revision?.distributionChannels ?? [])
    .map((channel) => channel.crxVersion)
    .filter(Boolean);
  return versions.sort(compareVersions).at(-1);
}

/** True when extension/ is identical at both refs; false when they differ or the old tag is missing. */
function extensionUnchanged(fromTag, toTag) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${fromTag}`], { stdio: "ignore" });
  } catch {
    return false;
  }
  try {
    execFileSync("git", ["diff", "--quiet", fromTag, toTag, "--", "extension/"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const zip = process.argv[2];
  const tag = process.argv[3];
  if (!zip || !tag) throw new Error("Pass the extension ZIP path and the release tag.");
  const version = tag.replace(/^v/, "");
  const key = JSON.parse(required("CWS_SERVICE_ACCOUNT_KEY"));
  const item = `${API}/v2/publishers/${required("CWS_PUBLISHER_ID")}/items/${required("CWS_EXTENSION_ID")}`;
  const uploadUrl = item.replace(`${API}/v2/`, `${API}/upload/v2/`);
  const token = await accessToken(key);

  const current = storeVersion(await call(token, "GET", `${item}:fetchStatus`));
  console.log(`Store version: ${current ?? "none"}; this release: ${version}`);
  if (current && compareVersions(current, version) >= 0) {
    notice(`the store already has ${current}; not uploading ${version}.`);
    return;
  }
  if (current && extensionUnchanged(`v${current}`, tag)) {
    notice(`extension/ is unchanged since v${current} (the version in the store); not uploading ${version}.`);
    return;
  }

  const upload = await call(token, "POST", `${uploadUrl}:upload`, { headers: { "content-type": "application/zip" }, body: readFileSync(zip) });
  let state = upload.uploadState;
  console.log(`Uploaded ${zip} (version ${upload.crxVersion ?? "?"}): ${state}`);
  for (let attempt = 0; state === "IN_PROGRESS" && attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    state = (await call(token, "GET", `${item}:fetchStatus`)).lastAsyncUploadState;
    console.log(`Upload state: ${state}`);
  }
  if (state !== "SUCCEEDED") throw new Error(`Upload did not succeed: ${state}`);

  const published = await call(token, "POST", `${item}:publish`, { headers: { "content-type": "application/json" }, body: "{}" });
  console.log(`Submitted for review: ${JSON.stringify(published)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
