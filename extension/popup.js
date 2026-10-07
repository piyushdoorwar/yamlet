const $ = (id) => document.getElementById(id);
let currentSite = null;
let working = false;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

async function send(type, extras = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extras });
  if (!response?.ok) throw new Error(response?.error || "Extension did not respond.");
  return response.result;
}

/** Disables the popup's buttons while an action runs. */
async function busy(message, action) {
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach((button) => { button.disabled = true; });
  if (message) status(message);
  working = true;
  let failure = null;
  try {
    await action();
  } catch (error) {
    failure = error;
  } finally {
    working = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
  await refresh().catch(() => {});
  if (failure) status(failure.message, true);
}

function siteRow(site) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.className = "mono";
  label.textContent = site;
  label.title = site;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-sm btn-danger-ghost";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => void busy("Removing…", () => send("removeSite", { site })));
  item.append(label, remove);
  return item;
}

async function refresh() {
  const { pairing, needsRepair, sites = [], lastSync, lastError, lastBase } = await chrome.storage.local.get(["pairing", "needsRepair", "sites", "lastSync", "lastError", "lastBase"]);
  $("pairSection").hidden = !!pairing;
  $("connectedSection").hidden = !pairing;
  if (pairing) {
    status(lastError ? `Connected, but sync failed: ${lastError}` : `Connected to ${pairing.base}`, !!lastError);
    if (sites.length) $("sites").replaceChildren(...sites.map(siteRow));
    else {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "None yet";
      $("sites").replaceChildren(empty);
    }
    $("lastSync").textContent = lastSync ? `Last sync ${new Date(lastSync.at).toLocaleString()} · ${lastSync.count} ${lastSync.count === 1 ? "cookie" : "cookies"}` : "No cookies synced yet.";
  } else {
    if (needsRepair) status(`Yamlet forgot this browser's pairing. Open Yamlet at ${needsRepair} and it reconnects automatically.`);
    else status(lastError || "Not connected to Yamlet", !!lastError);
    if (lastBase && document.activeElement !== $("base")) $("base").value = lastBase;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url);
    currentSite = !tab.incognito && ["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname) ? url.origin : null;
  } catch {
    currentSite = null;
  }
  $("site").textContent = currentSite || "Open a regular website tab to choose its cookies.";
  $("approve").disabled = !currentSite || !pairing;
}

$("pair").addEventListener("click", () => {
  const base = $("base").value.trim();
  const code = $("code").value.trim();
  if (!code) return status("Paste the pairing code from Yamlet.", true);
  void busy("Connecting…", async () => {
    await send("pair", { base, code });
    $("code").value = "";
  });
});

$("code").addEventListener("keydown", (event) => { if (event.key === "Enter") $("pair").click(); });

$("approve").addEventListener("click", () => {
  if (!currentSite) return;
  const site = currentSite;
  const url = new URL(site);
  void busy(null, async () => {
    // Recorded first: if Chrome's prompt closes the popup, the background finishes the
    // approval. Not awaited, so the request below still runs inside the click gesture.
    const recorded = chrome.storage.local.set({ pendingApproval: { site, at: Date.now() } });
    const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    await recorded;
    if (!granted) {
      await chrome.storage.local.remove("pendingApproval");
      throw new Error("Chrome site permission was not granted.");
    }
    status("Syncing…");
    await send("approve", { site });
  });
});

$("sync").addEventListener("click", () => void busy("Syncing…", () => send("sync")));
$("forget").addEventListener("click", () => void busy("Disconnecting…", () => send("forget")));

// Background syncs update storage; keep the open popup current.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local" && !working) void refresh().catch(() => {});
});

void refresh().catch((error) => status(error.message, true));
