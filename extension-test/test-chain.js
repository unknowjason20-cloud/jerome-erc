// Chain test for Flow Capture Observer v1.2.0 (mocked browser APIs).
// Simulates: MAIN-world hook (NO chrome) -> isolated bridge (chrome) ->
// background log, plus a duplicate webRequest event (must dedupe).
// Run: node test-chain.js   (exit 0 = PASS, exit 1 = FAIL)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let failures = [];
function check(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failures.push(name);
}

// ---------- shared fake window (same object in both worlds) ----------
const listeners = {};
const sharedWindow = {
  location: { href: "https://flow.google.com/project/x", origin: "https://flow.google.com" },
  addEventListener(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
  },
  postMessage(data, _origin) {
    const evts = (listeners.message || []).slice();
    for (const fn of evts) fn({ source: sharedWindow, data });
  },
  fetch(_input, _init) {
    return Promise.resolve({ ok: true });
  },
};
sharedWindow.window = sharedWindow;

class FakeXHR {
  open(_m, _u) {}
  send(_b) {}
}
class FakeRequest {
  constructor(url, init) {
    this.url = url;
    this.method = (init && init.method) || "GET";
    this._body = (init && init.body) || "";
  }
  clone() {
    const body = this._body;
    return { text: () => Promise.resolve(body) };
  }
}

// ---------- background context ----------
const store = {};
let bgOnMessage = null;
let wrListener = null;
const bgChrome = {
  storage: {
    local: {
      get(defs, cb) { cb({ ...defs, ...store }); },
      set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
    },
  },
  webRequest: {
    onBeforeRequest: {
      addListener(fn) { wrListener = fn; },
    },
  },
  runtime: {
    lastError: undefined,
    onMessage: { addListener(fn) { bgOnMessage = fn; } },
    sendMessage() {},
  },
};
const bgCtx = vm.createContext({ chrome: bgChrome, console, URL, TextDecoder });
vm.runInContext(read("background.js"), bgCtx, { filename: "background.js" });

// Helper: route a runtime.sendMessage into the background listener.
function routeToBackground(msg) {
  let response;
  bgOnMessage(msg, { tab: { id: 7 } }, (r) => { response = r; });
  return response;
}

// ---------- isolated-world bridge context ----------
const bridgeChrome = {
  runtime: {
    lastError: undefined,
    sendMessage(msg, cb) {
      const res = routeToBackground(msg);
      if (cb) cb(res);
    },
  },
};
const bridgeCtx = vm.createContext({ window: sharedWindow, chrome: bridgeChrome, console });
vm.runInContext(read("content-bridge.js"), bridgeCtx, { filename: "content-bridge.js" });

// ---------- MAIN-world hook context (NO chrome) ----------
const mainCtx = vm.createContext({
  window: sharedWindow,
  location: sharedWindow.location,
  XMLHttpRequest: FakeXHR,
  Request: FakeRequest,
  FormData,
  URLSearchParams,
  URL,
  console,
});
// Double-injection guard: load twice, fetch must still capture exactly once.
vm.runInContext(read("content-main.js"), mainCtx, { filename: "content-main.js" });
vm.runInContext(read("content-main.js"), mainCtx, { filename: "content-main.js" });

(async () => {
  const A_URL = "https://flow.google.com/_/VisualVideoModelUi/data/batchexecute?rpcids=ogiZ0b&rt=c";
  const B_URL = "https://flow.google.com/_/VisualVideoModelUi/data/batchexecute?rpcids=eb1hJf&rt=c";
  const D_URL = "https://flow.google.com/_/VisualVideoModelUi/data/batchexecute?rpcids=YhhmEf&rt=c";
  const A_BODY = "f.req=%5B%22a%20cat%20on%20a%20roof%22%5D";
  const B_BODY = "f.req=%5B%22a%20dog%20in%20the%20rain%22%5D";
  const D_BODY = "f.req=%5B%22a%20bird%20at%20dusk%22%5D";

  // Event A: fetch (string URL) — captured by the MAIN hook.
  await sharedWindow.fetch(A_URL, { method: "POST", body: A_BODY });
  // Event B: XHR — captured by the MAIN hook.
  const xhr = new FakeXHR();
  const mainXHR = vm.runInContext("XMLHttpRequest", mainCtx);
  const x = new mainXHR();
  x.open("POST", B_URL);
  x.send(B_BODY);
  void xhr;
  // Event C: the SAME request as A, seen via webRequest (desktop double
  // capture) — the background must dedupe it, not log it twice.
  wrListener({
    url: A_URL,
    method: "POST",
    timeStamp: Date.now(),
    tabId: 7,
    requestBody: { formData: { "f.req": ['["a cat on a roof"]'] } },
  });
  // Event D: fetch with a Request object — body read via clone().text().
  const Req = vm.runInContext("Request", mainCtx);
  await sharedWindow.fetch(new Req(D_URL, { method: "POST", body: D_BODY }));
  await new Promise((r) => setTimeout(r, 100)); // let the async capture land

  const log = routeToBackground({ type: "getLog" });
  const status = routeToBackground({ type: "getStatus" });
  const entries = (log && log.entries) || [];

  check("pageHookReady reached background (pageHook true)", status.pageHook === true);
  check("webRequest listener registered (webRequest true)", status.webRequest === true);
  check("exactly 3 unique entries (fetch + XHR + Request fetch; webRequest dup deduped)", entries.length === 3);
  check("all entries came via page-hook", entries.every((e) => e.source === "page-hook"));
  check("rpcids parsed: ogiZ0b, eb1hJf, YhhmEf", ["ogiZ0b", "eb1hJf", "YhhmEf"].every((id) => entries.some((e) => (e.rpcids || []).includes(id))));
  check("f.req bodies decoded", entries.some((e) => e.frep.includes("a cat on a roof")) && entries.some((e) => e.frep.includes("a dog in the rain")) && entries.some((e) => e.frep.includes("a bird at dusk")));
  check("no double capture from double-injected hook", entries.filter((e) => (e.rpcids || []).includes("ogiZ0b")).length === 1);
  check("status count matches log", status.count === entries.length);

  // Popup fallback path: getLog from storage when background is unreachable
  // is covered by loadFromStorage; here just check the log persisted.
  check("log persisted to storage.local", Array.isArray(store.flowCaptureLog) && store.flowCaptureLog.length === 3);

  if (failures.length) {
    console.log("\nCHAIN TEST FAIL (" + failures.length + " failed)");
    process.exit(1);
  }
  console.log("\nCHAIN TEST PASS (fetch + XHR + Request-object fetch reached the background log; dedupe verified)");
})();
