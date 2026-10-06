const $ = (id) => document.getElementById(id);
let currentSite = null;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

async function send(type, extras = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extras });
  if (!response?.ok) throw new Error(response?.error || "Extension did not respond.");
  return response.result;
}

async function refresh() {
  const { pairing, sites = [], lastSync, lastError } = await chrome.storage.local.get(["pairing", "sites", "lastSync", "lastError"]);
  $("pairSection").hidden = !!pairing;
  $("connectedSection").hidden = !pairing;
  if (pairing) {
    status(lastError ? `Connected, but sync failed: ${lastError}` : `Connected to ${pairing.base}`, !!lastError);
    $("sites").replaceChildren(...sites.map((site) => {
      const item = document.createElement("li");
      const label = document.createElement("span"); label.textContent = site;
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-site"; remove.textContent = "Remove";
      remove.addEventListener("click", async () => { try { await send("removeSite", { site }); await refresh(); } catch (error) { status(error.message, true); } });
      item.append(label, remove); return item;
    }));
    if (!sites.length) $("sites").textContent = "None yet";
    $("lastSync").textContent = lastSync ? `Last sync: ${new Date(lastSync.at).toLocaleString()} · ${lastSync.count} cookies` : "No cookies synced yet.";
  } else status("Not connected to Yamlet");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url);
    currentSite = !tab.incognito && ["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname) ? url.origin : null;
  } catch { currentSite = null; }
  $("site").textContent = currentSite || "Open a regular website tab to choose its cookies.";
  $("approve").disabled = !currentSite || !pairing;
}

$("pair").addEventListener("click", async () => {
  try { status("Connecting…"); await send("pair", { base: $("base").value.trim(), code: $("code").value.trim() }); await refresh(); }
  catch (error) { status(error.message, true); }
});
$("approve").addEventListener("click", async () => {
  try {
    const url = new URL(currentSite);
    const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    if (!granted) throw new Error("Chrome site permission was not granted.");
    status("Syncing…"); await send("approve", { site: currentSite }); await refresh();
  }
  catch (error) { status(error.message, true); }
});
$("sync").addEventListener("click", async () => {
  try { status("Syncing…"); await send("sync"); await refresh(); }
  catch (error) { status(error.message, true); }
});
$("forget").addEventListener("click", async () => {
  try { await send("forget"); await refresh(); }
  catch (error) { status(error.message, true); }
});
void refresh().catch((error) => status(error.message, true));
