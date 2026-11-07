// Chain test for Flow Capture Observer v1.3.0 (mocked browser APIs).
// Simulates: MAIN-world hook (NO chrome) -> isolated bridge (chrome) ->
// background log, plus the in-page floating panel (button + log list +
// getLog snapshot round-trip). Also asserts the manifest declares NO
// webRequest permission (Orion compatibility) and the background registers
// NO webRequest listener.
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

// ---------- fake DOM (minimal: createElement/body/appendChild/click) ----------
function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    textContent: "",
    _innerHTML: "",
    _listeners: {},
    value: "",
    href: "",
    download: "",
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener(t, fn) {
      (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    setAttribute() {},
    select() {},
    click() {
      (this._listeners.click || []).slice().forEach((fn) => fn.call(this));
    },
    remove() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return this._innerHTML;
    },
    set(v) {
      this._innerHTML = v;
      if (v === "") this.children = [];
    },
  });
  return el;
}
const bodyEl = makeElement("body");
const fakeDocument = {
  body: bodyEl,
  createElement: (tag) => makeElement(tag),
  addEventListener: () => {},
  execCommand: () => true,
};

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
const bgChrome = {
  storage: {
    local: {
      get(defs, cb) {
        cb({ ...defs, ...store });
      },
      set(obj, cb) {
        Object.assign(store, obj);
        if (cb) cb();
      },
    },
  },
  // NOTE: no webRequest at all in v1.3.0 — the background must not touch it.
  runtime: {
    lastError: undefined,
    onMessage: {
      addListener(fn) {
        bgOnMessage = fn;
      },
    },
    sendMessage() {},
  },
};
const bgCtx = vm.createContext({ chrome: bgChrome, console, URL, TextDecoder });
vm.runInContext(read("background.js"), bgCtx, { filename: "background.js" });

// Helper: route a runtime.sendMessage into the background listener.
function routeToBackground(msg) {
  let response;
  bgOnMessage(msg, { tab: { id: 7 } }, (r) => {
    response = r;
  });
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
const bridgeCtx = vm.createContext({
  window: sharedWindow,
  location: sharedWindow.location,
  chrome: bridgeChrome,
  console,
});
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
  Blob,
  document: fakeDocument,
  navigator: {},
  console,
});
// Double-injection guard: load twice, fetch must still capture exactly once.
vm.runInContext(read("content-main.js"), mainCtx, { filename: "content-main.js" });
vm.runInContext(read("content-main.js"), mainCtx, { filename: "content-main.js" });

(async () => {
  // ---- manifest: Orion compatibility ----
  const manifest = JSON.parse(read("manifest.json"));
  check("manifest version is 1.3.0", manifest.version === "1.3.0");
  check(
    "manifest declares NO webRequest permission",
    !((manifest.permissions || []).includes("webRequest"))
  );
  check(
    "manifest still declares both background keys (Orion prefers scripts)",
    !!(manifest.background && manifest.background.scripts && manifest.background.service_worker)
  );

  // ---- in-page panel: button injected at load ----
  const btn = bodyEl.children.find((c) => c.tagName === "BUTTON");
  const panel = bodyEl.children.find(
    (c) => c.tagName === "DIV" && c.style && c.style.position === "fixed"
  );
  check("floating Flow Log button injected into the page", !!btn);
  check("button starts at 0 captures", !!btn && btn.textContent.includes("(0)"));
  check("log panel injected but hidden", !!panel && panel.style.display === "none");

  const A_URL =
    "https://flow.google.com/_/VisualVideoModelUi/data/batchexecute?rpcids=ogiZ0b&rt=c";
  const B_URL =
    "https://flow.google.com/_/VisualVideoModelUi/data/batchexecute?rpcids=eb1hJf&rt=c";
  const D_URL =
    "https://flow.google.com/_/VisualVideoModelUi/data/batchexecute?rpcids=YhhmEf&rt=c";
  const A_BODY = "f.req=%5B%22a%20cat%20on%20a%20roof%22%5D";
  const B_BODY = "f.req=%5B%22a%20dog%20in%20the%20rain%22%5D";
  const D_BODY = "f.req=%5B%22a%20bird%20at%20dusk%22%5D";

  // Event A: fetch (string URL) — captured by the MAIN hook.
  await sharedWindow.fetch(A_URL, { method: "POST", body: A_BODY });
  // Event B: XHR — captured by the MAIN hook.
  const mainXHR = vm.runInContext("XMLHttpRequest", mainCtx);
  const x = new mainXHR();
  x.open("POST", B_URL);
  x.send(B_BODY);
  // Event D: fetch with a Request object — body read via clone().text().
  const Req = vm.runInContext("Request", mainCtx);
  await sharedWindow.fetch(new Req(D_URL, { method: "POST", body: D_BODY }));
  await new Promise((r) => setTimeout(r, 100)); // let the async capture land

  const log = routeToBackground({ type: "getLog" });
  const status = routeToBackground({ type: "getStatus" });
  const entries = (log && log.entries) || [];

  check("pageHookReady reached background (pageHook true)", status.pageHook === true);
  check("background reports webRequest off (no webRequest in v1.3.0)", status.webRequest === false);
  check("exactly 3 unique entries (fetch + XHR + Request fetch)", entries.length === 3);
  check("all entries came via page-hook", entries.every((e) => e.source === "page-hook"));
  check(
    "rpcids parsed: ogiZ0b, eb1hJf, YhhmEf",
    ["ogiZ0b", "eb1hJf", "YhhmEf"].every((id) =>
      entries.some((e) => (e.rpcids || []).includes(id))
    )
  );
  check(
    "f.req bodies decoded",
    entries.some((e) => e.frep.includes("a cat on a roof")) &&
      entries.some((e) => e.frep.includes("a dog in the rain")) &&
      entries.some((e) => e.frep.includes("a bird at dusk"))
  );
  check(
    "no double capture from double-injected hook",
    entries.filter((e) => (e.rpcids || []).includes("ogiZ0b")).length === 1
  );
  check("status count matches log", status.count === entries.length);
  check(
    "log persisted to storage.local",
    Array.isArray(store.flowCaptureLog) && store.flowCaptureLog.length === 3
  );

  // ---- in-page panel: button count + open + snapshot merge ----
  check("button count updated to 3 after captures", !!btn && btn.textContent.includes("(3)"));
  btn.click(); // opens the panel; requests the persisted-log snapshot
  const panelList = panel.children[1]; // [0] = header, [1] = list
  const listText = JSON.stringify(panelList.children.map((d) => d.children.map((c) => c.textContent)));
  check("panel opens (display block)", panel.style.display === "block");
  check(
    "panel lists 3 unique entries (local + snapshot deduped)",
    panelList.children.length === 3
  );
  check(
    "panel shows all three rpcids",
    ["ogiZ0b", "eb1hJf", "YhhmEf"].every((id) => listText.includes(id))
  );
  btn.click(); // closes again
  check("panel closes on second click", panel.style.display === "none");

  if (failures.length) {
    console.log("\nCHAIN TEST FAIL (" + failures.length + " failed)");
    process.exit(1);
  }
  console.log("\nCHAIN TEST PASS (page-hook chain + in-page panel + no webRequest)");
})();
