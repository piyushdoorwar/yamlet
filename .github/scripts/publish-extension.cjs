// Uploads the packaged extension to the Chrome Web Store and submits it for review.
//   node .github/scripts/publish-extension.cjs dist/yamlet-interceptor-1.2.3.zip
// Env: CWS_SERVICE_ACCOUNT_KEY (the service account's JSON key), CWS_PUBLISHER_ID,
// CWS_EXTENSION_ID. The service account must be added in the store's Developer
// Dashboard; it needs no Google Cloud roles.
const { createSign } = require("node:crypto");
const { readFileSync } = require("node:fs");

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

async function main() {
  const zip = process.argv[2];
  if (!zip) throw new Error("Pass the extension ZIP path.");
  const key = JSON.parse(required("CWS_SERVICE_ACCOUNT_KEY"));
  const item = `${API}/v2/publishers/${required("CWS_PUBLISHER_ID")}/items/${required("CWS_EXTENSION_ID")}`;
  const uploadUrl = item.replace(`${API}/v2/`, `${API}/upload/v2/`);
  const token = await accessToken(key);

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
