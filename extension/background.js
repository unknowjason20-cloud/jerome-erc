// Flow Capture Observer (background).
// Watches Flow's batchexecute requests and logs URL + rpcid + time + payload.
// OBSERVATION ONLY: it never reads auth headers or cookies, never replays a
// request and never submits anything. Everything stays in this browser.
//
// Page-hook-only build (v1.3.0, Orion-compatible): there is NO webRequest
// permission and no webRequest listener. Orion on iOS only partially
// supports webRequest, and merely declaring the permission triggers its
// "Extension Compatibility Issue" warning at install. The capture path is
// the MAIN-world content script (content-main.js) + bridge
// (content-bridge.js), which works wherever the page's own fetch/XHR runs.

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
  // Dedupe: the same request seen twice (e.g. page hook + a later
  // snapshot) must not log twice. Drop an identical url+body seen < 3s ago.
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

// Restore the persisted log so a suspended/killed background does not wipe it.
try {
  chrome.storage.local.get({ flowCaptureLog: [] }, (res) => {
    const saved = (res && res.flowCaptureLog) || [];
    if (Array.isArray(saved) && saved.length) {
      entries.push(...saved.slice(-MAX_ENTRIES));
    }
  });
} catch (e) {}

// Guarded like everything else: if chrome.runtime is somehow absent at
// startup, the listeners must not take the whole file down with them.
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
