// Flow Capture Observer (background service worker).
// Watches Flow's batchexecute requests and logs URL + rpcid + time + payload.
// OBSERVATION ONLY: it never reads auth headers or cookies, never replays a
// request and never submits anything. Everything stays in this browser.

const entries = [];
const MAX_ENTRIES = 500;
const MAX_BODY_CHARS = 200000;

function rpcidsFromUrl(url) {
  try {
    const ids = new URL(url).searchParams.get("rpcids");
    return ids ? ids.split(",") : [];
  } catch (e) {
    return [];
  }
}

function bodyText(details) {
  try {
    const rb = details.requestBody;
    if (!rb) return "";
    if (rb.formData && rb.formData["f.req"] && rb.formData["f.req"][0]) {
      return String(rb.formData["f.req"][0]).slice(0, MAX_BODY_CHARS);
    }
    if (rb.raw && rb.raw[0] && rb.raw[0].bytes) {
      return new TextDecoder().decode(new Uint8Array(rb.raw[0].bytes)).slice(0, MAX_BODY_CHARS);
    }
    return "";
  } catch (e) {
    return "";
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.url.includes("batchexecute")) return;
    entries.push({
      time: new Date(details.timeStamp).toISOString(),
      method: details.method,
      url: details.url,
      rpcids: rpcidsFromUrl(details.url),
      frep: bodyText(details),
      tabId: details.tabId,
    });
    if (entries.length > MAX_ENTRIES) entries.shift();
    chrome.storage.local.set({ flowCaptureLog: entries });
  },
  { urls: ["*://flow.google.com/*", "*://*.googleapis.com/*"] },
  ["requestBody"]
);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getLog") {
    sendResponse({ entries });
  } else if (msg.type === "clearLog") {
    entries.length = 0;
    chrome.storage.local.set({ flowCaptureLog: [] });
    sendResponse({ ok: true });
  }
  return true;
});
