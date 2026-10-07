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

/**
 * Sends a snapshot. A pairing Yamlet has forgotten (401, e.g. its /data volume was
 * replaced) is re-paired automatically from an open Yamlet tab, keeping the approved
 * sites. A pairing the user disconnected (403) is dropped so the popup asks to pair again.
 */
async function sendSnapshot(pairing, site, cookies) {
  const envelope = await encryptedSnapshot(pairing.secret, { site, cookies });
  try {
    return await post(pairing.base, "/api/interceptor/sync", { pairingId: pairing.pairingId, ...envelope });
  } catch (error) {
    if (error.status === 401) {
      await chrome.storage.local.remove("pairing");
      await chrome.storage.local.set({ needsRepair: pairing.base });
      void tryRepair();
      throw new Error(`Yamlet forgot this browser's pairing. It reconnects when Yamlet is open at ${pairing.base}.`);
    }
    if (error.status === 403) {
      await chrome.storage.local.remove(["pairing", "pendingRemovals", "needsRepair"]);
      throw new Error("Yamlet no longer recognizes this browser. Pair again from Yamlet's Cookies dialog.");
    }
    throw error;
  }
}

/** Exchanges a one-time code for a pairing with the Yamlet at `base`, then syncs. */
async function finishPair(base, code) {
  const result = await post(base, "/api/interceptor/pair/finish", { code: code.trim() });
  await chrome.storage.local.set({ pairing: { pairingId: result.pairingId, secret: result.secret, base }, lastBase: base, lastError: null });
  await chrome.storage.local.remove("needsRepair");
  // Not awaited: a repair can start inside a sync pass, which would then wait on itself.
  void initialize();
  return { paired: true };
}

/** Re-pairs with the address Yamlet forgot, using a code from one of its open tabs. */
let repairing = null;
function tryRepair() {
  repairing ??= (async () => {
    const { needsRepair } = await chrome.storage.local.get("needsRepair");
    if (!needsRepair) return;
    const tabs = await chrome.tabs.query({ url: ["http://localhost/*", "http://127.0.0.1/*"] });
    for (const tab of tabs) {
      if (!tab.url || new URL(tab.url).origin + "/" !== needsRepair) continue;
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "requestCode" }).catch(() => null);
      if (!reply?.code) continue;
      try {
        await finishPair(needsRepair, reply.code);
        return;
      } catch (error) {
        await chrome.storage.local.set({ lastError: error.message });
      }
    }
  })().finally(() => { repairing = null; });
  return repairing;
}

/**
 * A Yamlet page sent a pairing code (its "Pair extension" button). The address the
 * extension already trusts pairs at once; any other address waits for the user to
 * confirm it in the extension's own window, so another local page cannot pair the
 * extension with itself.
 */
async function pagePair(base, code, tabId) {
  endpoint(base, "/");
  const { pairing, needsRepair, lastBase } = await chrome.storage.local.get(["pairing", "needsRepair", "lastBase"]);
  if (base === (pairing?.base ?? needsRepair ?? lastBase)) return finishPair(base, code);
  // A second click while the window is open refreshes it instead of opening another.
  const { pendingPagePair: previous } = await chrome.storage.session.get("pendingPagePair");
  const open = previous?.windowId && (await chrome.windows.get(previous.windowId).catch(() => null));
  if (open) {
    if (previous.tabId !== tabId) notifyPairCancelled(previous.tabId);
    await chrome.storage.session.set({ pendingPagePair: { base, code, tabId, windowId: open.id } });
    await chrome.windows.update(open.id, { focused: true });
  } else {
    const created = await chrome.windows.create({ url: chrome.runtime.getURL("confirm.html"), type: "popup", width: 400, height: 330, focused: true });
    await chrome.storage.session.set({ pendingPagePair: { base, code, tabId, windowId: created.id } });
  }
  return { pending: true };
}

/** Tells the Yamlet page that asked to pair that the user declined, so it stops waiting. */
function notifyPairCancelled(tabId) {
  if (tabId !== undefined) void chrome.tabs.sendMessage(tabId, { type: "pairCancelled" }).catch(() => {});
}

async function cancelPagePair() {
  const { pendingPagePair } = await chrome.storage.session.get("pendingPagePair");
  await chrome.storage.session.remove("pendingPagePair");
  notifyPairCancelled(pendingPagePair?.tabId);
}

// Closing the confirmation window counts as Cancel.
chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get("pendingPagePair").then(({ pendingPagePair }) => {
    if (pendingPagePair?.windowId === windowId) return cancelPagePair();
  });
});

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
  const { sites = [], pairing, needsRepair } = await chrome.storage.local.get(["sites", "pairing", "needsRepair"]);
  if (needsRepair) await tryRepair();
  if (!pairing) return;
  const errors = [];
  try { await flushRemovals(); } catch (error) { errors.push(error.message); }
  for (const site of sites) {
    try { await syncSite(site); } catch (error) { errors.push(`${new URL(site).hostname}: ${error.message}`); }
    if (!(await chrome.storage.local.get("pairing")).pairing) break;
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
  // Messages from the bridge on a localhost page carry only what the page may ask for;
  // its address comes from Chrome (sender.origin), never from the message.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  (async () => {
    if (!fromExtensionPage) {
      const base = `${sender.origin}/`;
      if (message.type === "pagePair" && typeof message.code === "string") return pagePair(base, message.code, sender.tab?.id);
      if (message.type === "pageReady") {
        const { needsRepair } = await chrome.storage.local.get("needsRepair");
        if (needsRepair === base) await tryRepair();
        return { ok: true };
      }
      throw new Error("Unknown action.");
    }
    if (message.type === "pair") return finishPair(new URL(message.base).origin + "/", message.code);
    if (message.type === "confirmPagePair") {
      const { pendingPagePair } = await chrome.storage.session.get("pendingPagePair");
      await chrome.storage.session.remove("pendingPagePair");
      if (!pendingPagePair) throw new Error("The pairing request expired. Choose Pair extension in Yamlet again.");
      return finishPair(pendingPagePair.base, pendingPagePair.code);
    }
    if (message.type === "cancelPagePair") {
      await cancelPagePair();
      return { ok: true };
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
      await chrome.storage.local.remove(["pairing", "needsRepair", "sites", "pendingRemovals", "pendingApproval", "lastSync", "lastError"]);
      if (sites.length) await chrome.permissions.remove({ origins: sites.map(originPattern) }).catch(() => {});
      return { ok: true };
    }
    throw new Error("Unknown action.");
  })().then((result) => respond({ ok: true, result }), (error) => respond({ ok: false, error: error.message }));
  return true;
});

void initialize();
