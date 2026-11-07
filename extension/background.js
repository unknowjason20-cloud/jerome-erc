// Flow Capture Observer (background).
// Watches Flow's batchexecute requests and logs URL + rpcid + time + payload.
// OBSERVATION ONLY: it never reads auth headers or cookies, never replays a
// request and never submits anything. Everything stays in this browser.
//
// Two capture paths:
//  1. chrome.webRequest.onBeforeRequest (desktop Chrome / Orion macOS).
//     Guarded: on Orion iOS the webRequest events are partial or missing,
//     so a missing event must never abort this file.
//  2. A MAIN-world content script (content-main.js) that hooks the page's
//     own fetch/XHR. This is the working path on Orion iOS. It sends each
//     captured request here as a "pageRequest" message.

const entries = [];
const MAX_ENTRIES = 500;
const MAX_BODY_CHARS = 200000;

const status = { webRequest: false, pageHook: false };

function rpcidsFromUrl(url) {
  try {
    const ids = new URL(url).searchParams.get("rpcids");
    return ids ? ids.split(",") : [];
  } catch (e) {
    return [];
  }
}

function persist() {
  try {
    chrome.storage.local.set({ flowCaptureLog: entries }, () => {
      // Swallow storage errors (e.g. storage unavailable on this build).
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // storage namespace missing: keep the in-memory log only.
  }
}

function pushEntry(entry) {
  // Dedupe: on desktop both capture paths can see the same request
  // (webRequest + page hook). Drop an identical url+body seen < 3s ago.
  try {
    const t = Date.parse(entry.time || "");
    for (let i = entries.length - 1; i >= 0 && i >= entries.length - 20; i--) {
      const prev = entries[i];
      if (prev.url === entry.url && prev.frep === entry.frep) {
        const pt = Date.parse(prev.time || "");
        if (!isNaN(t) && !isNaN(pt) && Math.abs(t - pt) < 3000) return;
      }
    }
  } catch (e) {}
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  persist();
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

// Restore the persisted log so a suspended/killed background does not wipe it.
try {
  chrome.storage.local.get({ flowCaptureLog: [] }, (res) => {
    const saved = (res && res.flowCaptureLog) || [];
    if (Array.isArray(saved) && saved.length) {
      entries.push(...saved.slice(-MAX_ENTRIES));
    }
  });
} catch (e) {}

// Path 1: webRequest (guarded — missing on Orion iOS, must not throw).
try {
  const wr = chrome.webRequest && chrome.webRequest.onBeforeRequest;
  if (wr && typeof wr.addListener === "function") {
    wr.addListener(
      (details) => {
        if (!details.url.includes("batchexecute")) return;
        pushEntry({
          time: new Date(details.timeStamp).toISOString(),
          method: details.method,
          url: details.url,
          rpcids: rpcidsFromUrl(details.url),
          frep: bodyText(details),
          tabId: details.tabId,
          source: "webrequest",
        });
      },
      { urls: ["*://flow.google.com/*", "*://*.googleapis.com/*"] },
      ["requestBody"]
    );
    status.webRequest = true;
  }
} catch (e) {
  status.webRequest = false;
}

// Guarded like everything else: if chrome.runtime is somehow absent at
// startup, the listeners above must not take the whole file down with them.
try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  if (msg.type === "pageRequest" && msg.entry) {
    status.pageHook = true;
    const e = msg.entry;
    pushEntry({
      time: e.time || new Date().toISOString(),
      method: e.method || "",
      url: e.url || "",
      rpcids: Array.isArray(e.rpcids) ? e.rpcids : rpcidsFromUrl(e.url || ""),
      frep: typeof e.frep === "string" ? e.frep.slice(0, MAX_BODY_CHARS) : "",
      tabId: _sender && _sender.tab ? _sender.tab.id : -1,
      source: "page-hook",
    });
    sendResponse({ ok: true });
  } else if (msg.type === "pageHookReady") {
    status.pageHook = true;
    sendResponse({ ok: true });
  } else if (msg.type === "getLog") {
    sendResponse({ entries });
  } else if (msg.type === "getStatus") {
    sendResponse({ webRequest: status.webRequest, pageHook: status.pageHook, count: entries.length });
  } else if (msg.type === "clearLog") {
    entries.length = 0;
    persist();
    sendResponse({ ok: true });
  }
  return true;
  });
} catch (e) {
  // chrome.runtime missing: nothing else can be done from the background.
}
