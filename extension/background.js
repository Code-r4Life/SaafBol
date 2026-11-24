// SaafBol service worker.
// Content scripts run inside the page, so their requests count as the PAGE's (CORS rules, and https pages
// may not call http://127.0.0.1). The service worker has host_permissions, so ALL network calls go through here.
const API = "http://127.0.0.1:8000";

async function post(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("server " + r.status);
  return r.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "check") {
    post("/check", { text: msg.text })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // tells Chrome we will answer asynchronously
  }
  if (msg.type === "feedback") {
    post("/feedback", { original: msg.original, clean: msg.clean, rating: msg.rating, host: msg.host })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "lexicon") {
    // word lists for the live underlines: fetch fresh when the server is up, else fall back to the last copy we saved
    fetch(API + "/lexicon")
      .then((r) => { if (!r.ok) throw new Error("server " + r.status); return r.json(); })
      .then(async (data) => { await chrome.storage.local.set({ lexicon: data }); sendResponse({ ok: true, data }); })
      .catch(async () => {
        const cached = (await chrome.storage.local.get("lexicon")).lexicon;
        sendResponse(cached ? { ok: true, data: cached, cached: true } : { ok: false });
      });
    return true;
  }
});