const $ = (id) => document.getElementById(id);

function status(message) {
  $("status").hidden = false;
  $("status").textContent = message;
  $("status").classList.add("error");
}

async function send(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || "Extension did not respond.");
  return response.result;
}

$("connect").addEventListener("click", () => {
  $("connect").disabled = true;
  $("cancel").disabled = true;
  void send("confirmPagePair").then(
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
  if (!pendingPagePair) {
    $("base").textContent = "No pairing request is waiting.";
    $("connect").disabled = true;
    return;
  }
  $("base").textContent = pendingPagePair.base;
  $("connect").disabled = false;
  $("connect").focus();
}

void chrome.storage.session.get("pendingPagePair").then(({ pendingPagePair }) => show(pendingPagePair));
// Another Pair extension click reuses this window with a fresh request.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pendingPagePair?.newValue) show(changes.pendingPagePair.newValue);
});
