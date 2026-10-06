// Relays pairing messages between a local Yamlet page and the extension, so pairing
// needs no copied code. It runs on every localhost page; the background trusts only
// the tab's origin it sees itself, and pairs with a new address only after the user
// confirms it in the extension's own window.
const PAGE = "yamlet";
const EXTENSION = "yamlet-interceptor";
const waiting = new Map();

function toPage(message) {
  window.postMessage({ source: EXTENSION, ...message }, location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== PAGE) return;
  const { type, id, code, error } = event.data;
  if (type === "ping") toPage({ type: "pong" });
  else if (type === "pair" && typeof code === "string") {
    chrome.runtime.sendMessage({ type: "pagePair", code }).then(
      (response) => toPage({ type: "pairResult", ok: !!response?.ok, pending: !!response?.result?.pending, error: response?.error }),
      (err) => toPage({ type: "pairResult", ok: false, error: err.message }),
    );
  } else if (type === "code" && waiting.has(id)) {
    waiting.get(id)(typeof code === "string" ? { code } : { error: typeof error === "string" ? error : "Yamlet did not provide a code." });
    waiting.delete(id);
  }
});

// The background asks for a fresh code to re-pair after Yamlet forgot this browser.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "requestCode") return false;
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    waiting.delete(id);
    respond({ error: "This page is not a Yamlet window." });
  }, 5000);
  waiting.set(id, (result) => {
    clearTimeout(timer);
    respond(result);
  });
  toPage({ type: "codeRequest", id });
  return true;
});

toPage({ type: "pong" });
void chrome.runtime.sendMessage({ type: "pageReady" }).catch(() => {});
