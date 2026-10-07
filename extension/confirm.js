const $ = (id) => document.getElementById(id);
let shownId = null;
let armTimer;

function status(message) {
  $("status").hidden = false;
  $("status").textContent = message;
  $("status").classList.add("error");
}

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || "Extension did not respond.");
  return response.result;
}

$("connect").addEventListener("click", () => {
  $("connect").disabled = true;
  $("cancel").disabled = true;
  void send("confirmPagePair", { id: shownId }).then(
    () => window.close(),
    (error) => {
      status(error.message);
      $("cancel").disabled = false;
      $("cancel").textContent = "Close";
    },
  );
});

$("cancel").addEventListener("click", () => {
  void send("cancelPagePair").finally(() => window.close());
});

function show(pendingPagePair) {
  clearTimeout(armTimer);
  $("connect").disabled = true;
  if (!pendingPagePair) {
    shownId = null;
    $("base").textContent = "No pairing request is waiting.";
    return;
  }
  const changed = shownId !== null && pendingPagePair.base !== $("base").textContent;
  shownId = pendingPagePair.id;
  $("base").textContent = pendingPagePair.base;
  // A request that replaced the one on screen gets a moment to be read before Connect works.
  armTimer = setTimeout(() => {
    $("connect").disabled = false;
    $("connect").focus();
  }, changed ? 1500 : 0);
}

void chrome.storage.session.get("pendingPagePair").then(({ pendingPagePair }) => show(pendingPagePair));
// Another Pair extension click reuses this window with a fresh request.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pendingPagePair?.newValue) show(changes.pendingPagePair.newValue);
});
