const alarmName = "yamlet-cookie-sync";

chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

function endpoint(base, path) {
  const url = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an http://localhost or http://127.0.0.1 Yamlet address.");
  }
  return new URL(path, url).href;
}

async function post(base, path, body) {
  const response = await fetch(endpoint(base, path), {
    method: "POST",
    headers: { "content-type": "application/json", "x-yamlet": "1" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Yamlet returned ${response.status}.`);
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

function cookieAppliesToHost(host, cookie) {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  return cookie.hostOnly ? domain === host : host === domain || host.endsWith(`.${domain}`);
}

async function syncSite(site) {
  const { pairing } = await chrome.storage.local.get("pairing");
  if (!pairing) throw new Error("Pair with Yamlet first.");
  const url = new URL(site);
  const origin = `${url.protocol}//${url.hostname}/*`;
  if (!(await chrome.permissions.contains({ origins: [origin] }))) throw new Error(`Chrome permission for ${url.hostname} was removed.`);
  const found = [...await chrome.cookies.getAll({ domain: url.hostname }), ...await chrome.cookies.getAll({ url: `${site}/` })];
  const unique = new Map(found.map((cookie) => [`${cookie.storeId}:${cookie.domain}:${cookie.path}:${cookie.name}`, cookie]));
  const cookies = [...unique.values()].filter((cookie) => cookieAppliesToHost(url.hostname, cookie) && !cookie.partitionKey).map((cookie) => ({
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    hostOnly: cookie.hostOnly, secure: cookie.secure, httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite, expirationDate: cookie.expirationDate,
  }));
  const envelope = await encryptedSnapshot(pairing.secret, { site, cookies });
  const result = await post(pairing.base, "/api/interceptor/sync", { pairingId: pairing.pairingId, ...envelope });
  await chrome.storage.local.set({ lastSync: { site, count: result.count, at: new Date().toISOString() }, lastError: null });
  return result;
}

async function removeSite(site) {
  const { sites = [], pendingRemovals = [] } = await chrome.storage.local.get(["sites", "pendingRemovals"]);
  await chrome.storage.local.set({ sites: sites.filter((value) => value !== site), pendingRemovals: [...new Set([...pendingRemovals, site])] });
  await flushRemovals();
}

async function flushRemovals() {
  const { pendingRemovals = [], pairing } = await chrome.storage.local.get(["pendingRemovals", "pairing"]);
  if (!pairing) return;
  for (const site of pendingRemovals) {
    const envelope = await encryptedSnapshot(pairing.secret, { site, cookies: [] });
    await post(pairing.base, "/api/interceptor/sync", { pairingId: pairing.pairingId, ...envelope });
    const state = await chrome.storage.local.get("pendingRemovals");
    await chrome.storage.local.set({ pendingRemovals: (state.pendingRemovals || []).filter((value) => value !== site) });
  }
}

async function syncAll() {
  const { sites = [], pairing } = await chrome.storage.local.get(["sites", "pairing"]);
  if (!pairing) return;
  try { await flushRemovals(); } catch (error) { await chrome.storage.local.set({ lastError: error.message }); }
  for (const site of sites) {
    try { await syncSite(site); }
    catch (error) { await chrome.storage.local.set({ lastError: error.message }); }
  }
}

async function initialize() {
  if (!(await chrome.alarms.get(alarmName))) await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
  await syncAll();
}

chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === alarmName) void syncAll(); });

let changeTimer;
chrome.cookies.onChanged.addListener((change) => {
  if (change.cookie.partitionKey) return;
  void (async () => {
    const { sites = [] } = await chrome.storage.local.get("sites");
    if (!sites.some((site) => cookieAppliesToHost(new URL(site).hostname, change.cookie))) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { void syncAll(); }, 750);
  })();
});
chrome.permissions.onRemoved.addListener(() => {
  void (async () => {
    const { sites = [] } = await chrome.storage.local.get("sites");
    for (const site of sites) {
      const url = new URL(site);
      if (!(await chrome.permissions.contains({ origins: [`${url.protocol}//${url.hostname}/*`] }))) {
        try { await removeSite(site); } catch (error) { await chrome.storage.local.set({ lastError: error.message }); }
      }
    }
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  (async () => {
    if (message.type === "pair") {
      const result = await post(message.base, "/api/interceptor/pair/finish", { code: message.code.trim() });
      await chrome.storage.local.set({ pairing: { ...result, base: new URL(message.base).origin + "/" }, lastError: null });
      await initialize();
      return { paired: true };
    }
    if (message.type === "approve") {
      const site = new URL(message.site).origin;
      const url = new URL(site);
      if (!(await chrome.permissions.contains({ origins: [`${url.protocol}//${url.hostname}/*`] }))) throw new Error("Chrome site permission was not granted.");
      const { sites = [] } = await chrome.storage.local.get("sites");
      if (!sites.includes(site)) await chrome.storage.local.set({ sites: [...sites, site] });
      return syncSite(site);
    }
    if (message.type === "sync") return syncAll();
    if (message.type === "removeSite") {
      await removeSite(message.site);
      const url = new URL(message.site);
      await chrome.permissions.remove({ origins: [`${url.protocol}//${url.hostname}/*`] });
      return { ok: true };
    }
    if (message.type === "forget") {
      await chrome.storage.local.remove(["pairing", "sites", "pendingRemovals", "lastSync", "lastError"]);
      return { ok: true };
    }
    throw new Error("Unknown action.");
  })().then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: error.message }));
  return true;
});

void initialize();
