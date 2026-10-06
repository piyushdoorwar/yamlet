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

void chrome.storage.session.get("pendingPagePair").then(({ pendingPagePair }) => {
  if (!pendingPagePair) {
    $("base").textContent = "No pairing request is waiting.";
    return;
  }
  $("base").textContent = pendingPagePair.base;
  $("connect").disabled = false;
  $("connect").focus();
});
