const alarmName = "yamlet-cookie-sync";

class YamletError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function endpoint(base, path) {
  const url = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an http://localhost or http://127.0.0.1 Yamlet address.");
  }
  return new URL(path, url).href;
}

async function post(base, path, body) {
  let response;
  try {
    response = await fetch(endpoint(base, path), {
      method: "POST",
      headers: { "content-type": "application/json", "x-yamlet": "1" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`Could not reach Yamlet at ${new URL(base).origin}. Is it running?`);
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new YamletError(result.error || `Yamlet returned ${response.status}.`, response.status);
  return result;
}

function bytesToBase64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlToBytes(value) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptedSnapshot(secret, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", base64urlToBytes(secret), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv: bytesToBase64url(iv), ciphertext: bytesToBase64url(new Uint8Array(ciphertext)) };
}

/** The Chrome permission pattern for a site origin (any port). */
function originPattern(site) {
  const url = new URL(site);
  return `${url.protocol}//${url.hostname}/*`;
}

function cookieAppliesToHost(host, cookie) {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  return cookie.hostOnly ? domain === host : host === domain || host.endsWith(`.${domain}`);
}

/** Sends a snapshot; a revoked pairing is dropped so the popup asks to pair again. */
async function sendSnapshot(pairing, site, cookies) {
  const envelope = await encryptedSnapshot(pairing.secret, { site, cookies });
  try {
    return await post(pairing.base, "/api/interceptor/sync", { pairingId: pairing.pairingId, ...envelope });
  } catch (error) {
    if (error.status === 403) {
      await chrome.storage.local.remove(["pairing", "pendingRemovals"]);
      throw new Error("Yamlet no longer recognizes this browser. Pair again from Yamlet's Cookies dialog.");
    }
    throw error;
  }
}

async function syncSite(site) {
  const { pairing } = await chrome.storage.local.get("pairing");
  if (!pairing) throw new Error("Pair with Yamlet first.");
  const url = new URL(site);
  const host = url.hostname.toLowerCase();
  if (!(await chrome.permissions.contains({ origins: [originPattern(site)] }))) throw new Error(`Chrome permission for ${host} was removed.`);
  // The domain query covers host and subdomain cookies; the URL query adds parent-domain ones.
  const found = [...(await chrome.cookies.getAll({ domain: host })), ...(await chrome.cookies.getAll({ url: `${url.origin}/` }))];
  const unique = new Map(found.map((cookie) => [`${cookie.domain}:${cookie.path}:${cookie.name}`, cookie]));
  const cookies = [...unique.values()]
    .filter((cookie) => cookieAppliesToHost(host, cookie) && !cookie.partitionKey)
    .map((cookie) => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      hostOnly: cookie.hostOnly, secure: cookie.secure, httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite, expirationDate: cookie.session ? undefined : cookie.expirationDate,
    }));
  const result = await sendSnapshot(pairing, site, cookies);
  await chrome.storage.local.set({ lastSync: { site, count: result.count, at: new Date().toISOString() } });
  return result;
}

async function flushRemovals() {
  const { pendingRemovals = [], pairing } = await chrome.storage.local.get(["pendingRemovals", "pairing"]);
  if (!pairing) return;
  for (const site of pendingRemovals) {
    await sendSnapshot(pairing, site, []);
    const state = await chrome.storage.local.get("pendingRemovals");
    await chrome.storage.local.set({ pendingRemovals: (state.pendingRemovals || []).filter((value) => value !== site) });
  }
}

async function removeSite(site) {
  const { sites = [], pendingRemovals = [] } = await chrome.storage.local.get(["sites", "pendingRemovals"]);
  await chrome.storage.local.set({ sites: sites.filter((value) => value !== site), pendingRemovals: [...new Set([...pendingRemovals, site])] });
  await flushRemovals();
}

async function addSite(site) {
  if (!(await chrome.permissions.contains({ origins: [originPattern(site)] }))) throw new Error("Chrome site permission was not granted.");
  const { sites = [] } = await chrome.storage.local.get("sites");
  if (!sites.includes(site)) await chrome.storage.local.set({ sites: [...sites, site] });
  await chrome.storage.local.remove("pendingApproval");
  const result = await syncSite(site);
  await chrome.storage.local.set({ lastError: null });
  return result;
}

/** Runs one sync pass at a time; overlapping triggers coalesce into one more pass. */
let running = null;
let again = false;
function syncAll() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncPass();
    } while (again);
  })().finally(() => { running = null; });
  return running;
}

async function syncPass() {
  const { sites = [], pairing } = await chrome.storage.local.get(["sites", "pairing"]);
  if (!pairing) return;
  const errors = [];
  try { await flushRemovals(); } catch (error) { errors.push(error.message); }
  for (const site of sites) {
    try { await syncSite(site); } catch (error) { errors.push(`${new URL(site).hostname}: ${error.message}`); }
  }
  await chrome.storage.local.set({ lastError: errors.length ? [...new Set(errors)].join(" ") : null });
  if (errors.length) throw new Error(errors[0]);
}

async function initialize() {
  if (!(await chrome.alarms.get(alarmName))) await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
  await syncAll().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === alarmName) void syncAll().catch(() => {}); });

let changeTimer;
chrome.cookies.onChanged.addListener((change) => {
  if (change.cookie.partitionKey) return;
  void (async () => {
    const { sites = [] } = await chrome.storage.local.get("sites");
    if (!sites.some((site) => cookieAppliesToHost(new URL(site).hostname, change.cookie))) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { void syncAll().catch(() => {}); }, 750);
  })();
});

// Chrome's permission prompt can close the popup before it hears back, so the
// approval it started is finished here.
chrome.permissions.onAdded.addListener((granted) => {
  void (async () => {
    const { pendingApproval } = await chrome.storage.local.get("pendingApproval");
    if (!pendingApproval || !granted.origins?.includes(originPattern(pendingApproval))) return;
    try { await addSite(pendingApproval); } catch (error) { await chrome.storage.local.set({ lastError: error.message }); }
  })();
});

chrome.permissions.onRemoved.addListener(() => {
  void (async () => {
    const { sites = [] } = await chrome.storage.local.get("sites");
    for (const site of sites) {
      if (!(await chrome.permissions.contains({ origins: [originPattern(site)] }))) {
        try { await removeSite(site); } catch (error) { await chrome.storage.local.set({ lastError: error.message }); }
      }
    }
  })();
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    if (message.type === "pair") {
      const base = new URL(message.base).origin + "/";
      const result = await post(base, "/api/interceptor/pair/finish", { code: message.code.trim() });
      await chrome.storage.local.set({ pairing: { pairingId: result.pairingId, secret: result.secret, base }, lastBase: base, lastError: null });
      await initialize();
      return { paired: true };
    }
    if (message.type === "approve") return addSite(new URL(message.site).origin);
    if (message.type === "sync") return syncAll();
    if (message.type === "removeSite") {
      await removeSite(message.site);
      await chrome.permissions.remove({ origins: [originPattern(message.site)] });
      return { ok: true };
    }
    if (message.type === "forget") {
      // Clear this browser's imports in Yamlet first; Yamlet may be unreachable.
      const { sites = [], pendingRemovals = [] } = await chrome.storage.local.get(["sites", "pendingRemovals"]);
      await chrome.storage.local.set({ sites: [], pendingRemovals: [...new Set([...pendingRemovals, ...sites])] });
      await flushRemovals().catch(() => {});
      await chrome.storage.local.remove(["pairing", "sites", "pendingRemovals", "pendingApproval", "lastSync", "lastError"]);
      if (sites.length) await chrome.permissions.remove({ origins: sites.map(originPattern) }).catch(() => {});
      return { ok: true };
    }
    throw new Error("Unknown action.");
  })().then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: error.message }));
  return true;
});

void initialize();
