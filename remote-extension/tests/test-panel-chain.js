// Flow Remote — node mock chain test for the v1.1.0 in-page panel.
// NOT shipped in the extension ZIP. Run: node tests/test-panel-chain.js
// Uses a fake DOM + mocked chrome.* + mocked fetch with canned server
// responses. Covers the v1.1.0 brief's required cases:
//   1. panel injects (host on documentElement, floating button, hidden panel)
//   2. button toggles panel open/closed
//   3. settings save/load round-trip via mocked chrome.storage
//   4. message-to-background proxy (mocked fetch) for Test connection,
//      accounts, job submit, job list
//   5. blocked-job handling (warning shown, never re-sent)
//   6. background beacon (RUNNING / NOT RESPONDING) + api proxy + ping
// Plus static checks: manifest, no webRequest / storage.session /
// permissions.request, no inline handlers, no Object.prototype patch,
// no background timers, popup kept as desktop fallback.

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const EXT_DIR = path.join(__dirname, "..");
const api = require(path.join(EXT_DIR, "api.js"));

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log("PASS  " + name);
  } catch (e) {
    fail++;
    failures.push(name + ": " + (e && e.message ? e.message : String(e)));
    console.log("FAIL  " + name + " — " + (e && e.message ? e.message : String(e)));
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Canned server (same routes as tests/test-popup.js)
// ---------------------------------------------------------------------------

function cannedFetchFactory(calls) {
  const routes = {
    "GET /health": { status: 200, body: { ok: true, version: "1.0.0", gflow: true, stopped: false, queue: { running: 1, queued: 2 } } },
    "GET /accounts": { status: 200, body: [{ name: "main", google_account: "user@example.com", session: "present", is_default: true }, { name: "alt", google_account: "alt@example.com", session: "missing", is_default: false }] },
    "GET /jobs": {
      status: 200, body: [
        { id: "job-done-1", kind: "image", prompt: "a cat in a hat", profile: "main", status: "done", results: { media: [{ url: "https://example.com/media/cat.png", kind: "image" }] } },
        { id: "job-blocked-1", kind: "video", prompt: "a dog surfing", profile: "main", status: "blocked", error: "unusual activity detected", error_code: "blocked" },
        { id: "job-run-1", kind: "image", prompt: "a bird", profile: "main", status: "running" }
      ]
    },
    "POST /jobs": { status: 201, body: { id: "job-new-9", status: "queued" } }
  };
  return async function mockFetch(url, opts) {
    calls.push({ url, opts });
    const method = (opts && opts.method) || "GET";
    const u = String(url);
    const key = method + " " + (u.endsWith("/health") ? "/health" : u.endsWith("/accounts") ? "/accounts" : u.endsWith("/jobs") ? "/jobs" : "/jobs");
    const route = routes[key] || { status: 404, body: { error: "not found" } };
    return { status: route.status, json: async () => route.body };
  };
}

// ---------------------------------------------------------------------------
// Fake DOM (just enough for content-panel.js)
// ---------------------------------------------------------------------------

function matchesSelector(el, sel) {
  let s = String(sel).trim();
  let needChecked = false;
  if (s.slice(-8) === ":checked") { needChecked = true; s = s.slice(0, -8); }
  if (needChecked && !el.checked) return false;
  if (s.charAt(0) === ".") {
    const cls = s.slice(1);
    return (el.className || "").split(/\s+/).indexOf(cls) >= 0;
  }
  const m = s.match(/^([a-zA-Z0-9]+)?(?:\[([a-zA-Z-]+)="([^"]*)"\])?$/);
  if (!m) return false;
  if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  if (m[2]) {
    const attrVal = m[2] === "name" ? (el.name || null) : el.getAttribute(m[2]);
    if (attrVal !== m[3]) return false;
  }
  return true;
}

function FakeElement(tag) {
  this.tagName = String(tag || "div").toUpperCase();
  this.children = [];
  this.style = {};
  this.attributes = {};
  this._listeners = {};
  this._text = "";
  this._html = "";
  this.value = "";
  this.checked = false;
  this.selected = false;
  this.disabled = false;
  this.className = "";
  this.id = "";
  this.name = "";
  this.type = "";
  this.parentNode = null;
  this.shadowRoot = null;
  this.host = null;
}
FakeElement.prototype.appendChild = function (el) {
  el.parentNode = this;
  this.children.push(el);
  return el;
};
FakeElement.prototype.remove = function () {
  if (this.parentNode) {
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
};
FakeElement.prototype.setAttribute = function (k, v) {
  this.attributes[k] = String(v);
  if (k === "id") this.id = String(v);
  if (k === "type") this.type = String(v);
};
FakeElement.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
};
FakeElement.prototype.addEventListener = function (type, fn) {
  (this._listeners[type] = this._listeners[type] || []).push(fn);
};
FakeElement.prototype.dispatch = function (type, ev) {
  const e = ev || {};
  e.type = type;
  if (!e.preventDefault) e.preventDefault = function () {};
  if (!e.stopPropagation) e.stopPropagation = function () { e._stopped = true; };
  const list = (this._listeners[type] || []).slice();
  for (let i = 0; i < list.length; i++) list[i].call(this, e);
  return e;
};
FakeElement.prototype.click = function () { this.dispatch("click"); };
FakeElement.prototype.select = function () {};
FakeElement.prototype.attachShadow = function () {
  const sr = new FakeElement("#shadow-root");
  sr.host = this;
  this.shadowRoot = sr;
  return sr;
};
FakeElement.prototype.querySelectorAll = function (sel) {
  const out = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (matchesSelector(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(this);
  return out;
};
FakeElement.prototype.querySelector = function (sel) {
  const r = this.querySelectorAll(sel);
  return r.length ? r[0] : null;
};
FakeElement.prototype.getElementById = function (id) {
  if (this.id === id) return this;
  for (const c of this.children) {
    const f = c.getElementById(id);
    if (f) return f;
  }
  return null;
};
Object.defineProperty(FakeElement.prototype, "textContent", {
  get: function () { return this._text; },
  set: function (v) { this._text = String(v == null ? "" : v); }
});
Object.defineProperty(FakeElement.prototype, "innerHTML", {
  get: function () { return this._html; },
  set: function (v) { this._html = String(v); this.children = []; }
});

function makeDocument() {
  const docEl = new FakeElement("html");
  const body = new FakeElement("body");
  docEl.appendChild(body);
  return {
    documentElement: docEl,
    body: body,
    readyState: "complete",
    createElement: function (tag) { return new FakeElement(tag); },
    createTextNode: function (text) {
      const n = new FakeElement("#text");
      n.textContent = text;
      return n;
    },
    addEventListener: function () {},
    execCommand: function () { return true; },
    querySelector: function () { return null; },
    getElementById: function (id) { return docEl.getElementById(id); }
  };
}

// ---------------------------------------------------------------------------
// Mocked chrome for the panel test
// ---------------------------------------------------------------------------

const store = {
  serverUrl: "https://test-8766.app.github.dev/",
  token: "secret-token-123",
  flowRemotePanelOpen: false,
  flowRemoteJobs: [],
  flowRemoteBeacon: { version: "1.1.0", startedAt: "2026-11-07T00:00:00.000Z", alive: true }
};
const fetchCalls = [];
let noPing = false;

function mockSendMessage(msg, cb) {
  if (!msg || typeof msg.type !== "string") { if (cb) cb(null); return; }
  if (msg.type === "ping") {
    if (noPing) return; // background never answers
    if (cb) cb({ ok: true, alive: true, version: "1.1.0" });
    return;
  }
  if (msg.type === "getSettings") {
    if (cb) cb({ ok: true, settings: { serverUrl: store.serverUrl, token: store.token } });
    return;
  }
  if (msg.type === "api") {
    api.request(msg.settings, msg.method, msg.path, msg.body == null ? null : msg.body, cannedFetchFactory(fetchCalls))
      .then((data) => { if (cb) cb({ ok: true, data: data }); })
      .catch((err) => { if (cb) cb({ ok: false, code: err.code || "server", message: err.message || "error" }); });
    return;
  }
  if (cb) cb(null);
}

function makeStorageMock(backing) {
  return {
    get: function (keys, cb) {
      const res = {};
      if (typeof keys === "string") { res[keys] = backing[keys]; }
      else if (Array.isArray(keys)) { keys.forEach((k) => { res[k] = backing[k]; }); }
      else if (keys && typeof keys === "object") {
        Object.keys(keys).forEach((k) => {
          res[k] = (backing[k] !== undefined) ? backing[k] : keys[k];
        });
      }
      if (cb) cb(res);
    },
    set: function (obj, cb) {
      Object.keys(obj || {}).forEach((k) => { backing[k] = obj[k]; });
      if (cb) cb();
    }
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
  const panelSrc = fs.readFileSync(path.join(EXT_DIR, "content-panel.js"), "utf8");
  const bgSrc = fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8");
  const popupSrc = fs.readFileSync(path.join(EXT_DIR, "popup.js"), "utf8");

  // ---- static checks ----
  await check("manifest v1.1.0: content script on flow.google.com + popup kept", () => {
    assert.strictEqual(manifest.version, "1.1.0");
    assert.strictEqual(manifest.manifest_version, 3);
    assert.deepStrictEqual(manifest.permissions, ["storage"]);
    assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length >= 1);
    const cs = manifest.content_scripts[0];
    assert.deepStrictEqual(cs.matches, ["*://flow.google.com/*"]);
    assert.ok(cs.js.includes("content-panel.js"), "content script must load content-panel.js");
    assert.ok(cs.js.includes("api.js"), "content script must load api.js before the panel");
    assert.ok(manifest.host_permissions.some((h) => h.includes("*.app.github.dev")),
      "host_permissions must cover *.app.github.dev");
    assert.ok(manifest.host_permissions.some((h) => h.includes("localhost")),
      "host_permissions must cover localhost");
    assert.strictEqual(manifest.action.default_popup, "popup.html", "popup kept as desktop fallback");
    assert.ok(Array.isArray(manifest.background.scripts) &&
      manifest.background.scripts.includes("api.js") &&
      manifest.background.scripts.includes("background.js"),
      "background.scripts must load api.js then background.js");
    assert.strictEqual(manifest.background.service_worker, "background.js");
    for (const f of ["content-panel.js", "background.js", "api.js", "popup.js", "popup.html"]) {
      assert.ok(fs.existsSync(path.join(EXT_DIR, f)), f + " missing");
      assert.ok(fs.existsSync(path.join(EXT_DIR, "icons", "icon48.png")), "icons missing");
    }
  });

  await check("no webRequest / storage.session / permissions.request anywhere in the extension", () => {
    for (const f of ["manifest.json", "background.js", "content-panel.js", "popup.js", "popup.html", "api.js"]) {
      const src = fs.readFileSync(path.join(EXT_DIR, f), "utf8");
      // Comments may name the forbidden APIs; only code lines count.
      const codeLines = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l.trim()));
      assert.ok(!codeLines.some((l) => /webRequest/.test(l)), "webRequest in code of " + f);
      assert.ok(!codeLines.some((l) => /storage\.session/.test(l)), "storage.session in code of " + f);
      assert.ok(!codeLines.some((l) => /permissions\.request/.test(l)), "chrome.permissions.request in code of " + f);
    }
  });

  await check("panel: no inline handlers, no injected <script>, no Object.prototype patch", () => {
    // Comments may name the forbidden patterns; only code lines count.
    const codeLines = panelSrc.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l.trim()));
    const code = codeLines.join("\n");
    assert.ok(!/on(click|change|input|submit)\s*=/.test(code), "inline handler in content-panel.js");
    assert.ok(!/<script/i.test(code), "<script> in content-panel.js");
    assert.ok(!/Object\.prototype/.test(code), "Object.prototype patch in content-panel.js");
    assert.ok(/all:?\s*["']?initial/.test(panelSrc) || /all["']?\s*:\s*"initial"/.test(panelSrc),
      "host must use all: initial");
    assert.ok(panelSrc.includes("documentElement"), "shadow host must be on documentElement");
    assert.ok(panelSrc.includes("calc(100vw - 20px)"), "panel width must be calc(100vw - 20px)");
    assert.ok(panelSrc.includes("520px"), "panel max width 520px");
    assert.ok(panelSrc.includes("{ passive: false }") || panelSrc.includes("{passive:false}"),
      "drag touch handlers must use {passive:false}");
  });

  await check("background: guarded importScripts, no timers/polling, beacon written", () => {
    assert.ok(/typeof importScripts === "function"/.test(bgSrc), "importScripts must be typeof-guarded");
    assert.ok(!/setInterval/.test(bgSrc), "background must not poll");
    assert.ok(!/setTimeout/.test(bgSrc), "background must not use timers");
    assert.ok(bgSrc.includes("flowRemoteBeacon"), "background must write the health beacon");
    assert.ok(/type:\s*"api"/.test(bgSrc) || /"api"/.test(bgSrc), "background must handle api proxy messages");
    assert.ok(/type:\s*"ping"/.test(bgSrc) || /"ping"/.test(bgSrc), "background must answer ping");
    assert.ok(/type:\s*"getSettings"/.test(bgSrc) || /"getSettings"/.test(bgSrc),
      "background must keep getSettings for the popup");
  });

  await check("blocked job is never re-sent from the panel (no retry scheduling)", () => {
    assert.ok(panelSrc.includes("never re-sent") || panelSrc.includes("never auto-retry"),
      "panel lacks the no-resend note");
    assert.ok(!/setTimeout\([^)]*createJob/.test(panelSrc), "panel schedules a createJob retry");
    assert.ok(!/setInterval\([^)]*createJob/.test(panelSrc), "panel schedules a createJob poll-retry");
  });

  // ---- background.js behaviour (mocked chrome + mocked fetch) ----
  let bgListener = null;
  const bgStore = { serverUrl: "https://bg.app.github.dev", token: "bg-token" };
  const bgFetchCalls = [];
  const origFetch = typeof global.fetch === "function" ? global.fetch : null;
  global.fetch = cannedFetchFactory(bgFetchCalls);
  global.chrome = {
    storage: { local: makeStorageMock(bgStore) },
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => { bgListener = fn; } }
    }
  };
  delete require.cache[require.resolve(path.join(EXT_DIR, "background.js"))];
  require(path.join(EXT_DIR, "background.js"));

  function bgSend(msg) {
    return new Promise((resolve) => {
      const answered = bgListener(msg, {}, (res) => resolve(res));
      if (answered === false) resolve(undefined);
    });
  }

  await check("background writes boot beacon to storage.local", () => {
    const b = bgStore.flowRemoteBeacon;
    assert.ok(b, "no beacon in storage");
    assert.strictEqual(b.version, "1.1.0");
    assert.ok(typeof b.startedAt === "string" && b.startedAt.length > 0, "beacon needs startedAt");
    assert.strictEqual(b.alive, true);
  });

  await check("background answers ping {ok, alive}", async () => {
    assert.ok(typeof bgListener === "function", "onMessage listener not registered");
    const res = await bgSend({ type: "ping" });
    assert.ok(res && res.ok === true && res.alive === true);
  });

  await check("background api proxy: GET /health sends token header, replies data", async () => {
    bgFetchCalls.length = 0;
    const res = await bgSend({
      type: "api", method: "GET", path: "/health",
      settings: { serverUrl: "https://test-8766.app.github.dev/", token: "secret-token-123" }
    });
    assert.ok(res && res.ok === true && res.data && res.data.ok === true, "proxy did not return health data");
    assert.strictEqual(bgFetchCalls.length, 1);
    assert.ok(bgFetchCalls[0].url.endsWith("/health"), "wrong URL: " + bgFetchCalls[0].url);
    assert.strictEqual(bgFetchCalls[0].opts.headers["X-Flow-Token"], "secret-token-123");
  });

  await check("background api proxy: 401 -> {ok:false, code wrong_token}", async () => {
    global.fetch = async () => ({ status: 401, json: async () => ({ error: "bad token" }) });
    const res = await bgSend({
      type: "api", method: "GET", path: "/health",
      settings: { serverUrl: "https://test-8766.app.github.dev/", token: "bad" }
    });
    assert.ok(res && res.ok === false && res.code === "wrong_token", "expected wrong_token, got " + JSON.stringify(res));
    global.fetch = cannedFetchFactory(bgFetchCalls);
  });

  await check("background api proxy: missing settings -> not_configured, no fetch", async () => {
    const before = bgFetchCalls.length;
    const res = await bgSend({ type: "api", method: "GET", path: "/health", settings: { serverUrl: "", token: "" } });
    assert.ok(res && res.ok === false && res.code === "not_configured", "expected not_configured, got " + JSON.stringify(res));
    assert.strictEqual(bgFetchCalls.length, before, "fetch attempted with no settings");
  });

  await check("background still answers getSettings (popup compat)", async () => {
    const res = await bgSend({ type: "getSettings" });
    assert.ok(res && res.ok && res.settings.serverUrl === "https://bg.app.github.dev");
    assert.strictEqual(res.settings.token, "bg-token");
  });

  if (origFetch) global.fetch = origFetch; else delete global.fetch;

  // ---- panel behaviour (fake DOM + mocked chrome) ----
  const fakeDoc = makeDocument();
  global.document = fakeDoc;
  global.window = { addEventListener: function () {} };
  global.chrome = {
    storage: { local: makeStorageMock(store) },
    runtime: {
      lastError: undefined,
      sendMessage: mockSendMessage,
      onMessage: { addListener: function () {} }
    }
  };
  delete require.cache[require.resolve(path.join(EXT_DIR, "content-panel.js"))];
  const panel = require(path.join(EXT_DIR, "content-panel.js"));
  await flush(); await flush(); await flush();

  const sr = panel.internals.getShadowRoot();
  const el = (id) => (sr ? sr.getElementById(id) : null);

  await check("panel injects: host on documentElement, floating button, panel hidden", () => {
    assert.ok(sr, "no shadow root");
    const host = fakeDoc.documentElement.getElementById("fr-host");
    assert.ok(host, "host not appended to documentElement");
    assert.strictEqual(host.style.all, "initial", "host must use all: initial");
    const btn = el("fr-btn");
    assert.ok(btn, "floating button missing");
    assert.ok(btn.textContent.includes("Flow Remote"), "button label wrong: " + btn.textContent);
    assert.strictEqual(btn.style.position, "fixed");
    assert.strictEqual(btn.style.bottom, "12px");
    const p = el("fr-panel");
    assert.ok(p, "panel missing");
    assert.strictEqual(p.style.display, "none", "panel must start hidden");
    assert.strictEqual(p.style.maxWidth, "520px");
    assert.ok(p.style.width.includes("calc(100vw - 20px)"), "panel width wrong: " + p.style.width);
  });

  await check("settings load from storage into the inputs (16px, autocorrect off)", () => {
    const url = el("fr-server-url");
    const tok = el("fr-token");
    const prompt = el("fr-prompt");
    assert.ok(url && tok && prompt, "settings/prompt inputs missing");
    assert.strictEqual(url.value, "https://test-8766.app.github.dev/");
    assert.strictEqual(tok.value, "secret-token-123");
    assert.strictEqual(url.style.fontSize, "16px", "URL input must be 16px (iOS zoom)");
    assert.strictEqual(tok.style.fontSize, "16px", "token input must be 16px");
    assert.strictEqual(prompt.style.fontSize, "16px", "prompt input must be 16px");
    assert.strictEqual(url.getAttribute("autocomplete"), "off");
    assert.strictEqual(url.getAttribute("autocapitalize"), "off");
    assert.strictEqual(url.getAttribute("autocorrect"), "off");
    assert.strictEqual(tok.getAttribute("autocorrect"), "off");
    assert.strictEqual(url.getAttribute("inputmode"), "url");
  });

  await check("beacon line shows RUNNING when beacon present + ping answers", async () => {
    await flush();
    const state = await panel.internals.refreshBeacon();
    assert.strictEqual(state, "RUNNING");
    assert.ok(el("fr-bg-health").textContent.includes("RUNNING"),
      "beacon line: " + el("fr-bg-health").textContent);
  });

  await check("status line shows Connected after /health via proxy", async () => {
    await panel.internals.refreshHealth();
    assert.strictEqual(el("fr-status").textContent, "Connected");
    assert.ok(el("fr-status-detail").textContent.includes("Server OK"),
      "status detail: " + el("fr-status-detail").textContent);
  });

  await check("button toggles panel open then closed", () => {
    const btn = el("fr-btn");
    const p = el("fr-panel");
    btn.click();
    assert.strictEqual(p.style.display, "block", "panel did not open");
    assert.ok(panel.internals.isPanelOpen(), "panelOpen flag false after open");
    btn.click();
    assert.strictEqual(p.style.display, "none", "panel did not close");
    assert.ok(!panel.internals.isPanelOpen(), "panelOpen flag true after close");
  });

  await check("settings save round-trip: normalize URL, store token, 'Saved.'", async () => {
    const url = el("fr-server-url");
    const tok = el("fr-token");
    url.value = "https://other-8766.app.github.dev///";
    tok.value = "new-token-456";
    el("fr-save-settings").click();
    await flush();
    assert.strictEqual(store.serverUrl, "https://other-8766.app.github.dev", "trailing slashes not stripped");
    assert.strictEqual(store.token, "new-token-456");
    assert.strictEqual(el("fr-settings-msg").textContent, "Saved.");
    // Restore the canned-test settings for the remaining checks.
    // (Save normalizes the trailing slash away — that is the point.)
    url.value = "https://test-8766.app.github.dev/";
    tok.value = "secret-token-123";
    el("fr-save-settings").click();
    await flush();
    assert.strictEqual(store.serverUrl, "https://test-8766.app.github.dev");
  });

  await check("Test connection via proxy reports OK + server version", async () => {
    el("fr-test-connection").click();
    await flush(); await flush();
    const msg = el("fr-settings-msg").textContent;
    assert.ok(/OK — server v1\.0\.0/.test(msg), "test-connection msg: " + msg);
  });

  await check("accounts load: 2 options, default main; missing-session warning for alt", async () => {
    await panel.internals.refreshAccounts();
    await flush();
    const sel = el("fr-account");
    assert.strictEqual(sel.children.length, 2, "expected 2 account options");
    assert.strictEqual(sel.children[0].value, "main");
    assert.ok(sel.children[0].textContent.includes("session OK"));
    sel.value = "alt";
    sel.dispatch("change");
    assert.ok(el("fr-account-warn").textContent.includes("no saved session"),
      "alt warn: " + el("fr-account-warn").textContent);
    sel.value = "main";
    sel.dispatch("change");
    assert.strictEqual(el("fr-account-warn").textContent, "");
  });

  await check("kind switch swaps model lists + count/duration rows", () => {
    const radios = sr.querySelectorAll('input[name="fr-kind"]');
    assert.strictEqual(radios.length, 2, "expected 2 kind radios");
    const img = radios.find((r) => r.value === "image");
    const vid = radios.find((r) => r.value === "video");
    vid.checked = true; img.checked = false;
    vid.dispatch("change");
    const modelVals = el("fr-model").children.map((o) => o.value);
    assert.deepStrictEqual(modelVals, ["veo-lite", "veo-fast", "omni-flash"]);
    assert.strictEqual(el("fr-count-row").style.display, "none");
    assert.strictEqual(el("fr-duration-row").style.display, "");
    img.checked = true; vid.checked = false;
    img.dispatch("change");
    assert.deepStrictEqual(el("fr-model").children.map((o) => o.value),
      ["nano2", "nano-pro", "nano2-lite", "imagen4"]);
    assert.strictEqual(el("fr-count-row").style.display, "");
  });

  await check("job submit via proxy: POST /jobs with prompt/model/aspect/count, prompt cleared", async () => {
    const model = el("fr-model");
    model.value = "nano2";
    el("fr-aspect").value = "9:16";
    el("fr-count").value = "1";
    el("fr-account").value = "main";
    el("fr-prompt").value = "a cat in a hat";
    const postsBefore = fetchCalls.filter((c) => (c.opts && c.opts.method) === "POST").length;
    el("fr-send-job").click();
    await flush(); await flush(); await flush();
    const posts = fetchCalls.filter((c) => (c.opts && c.opts.method) === "POST");
    assert.strictEqual(posts.length, postsBefore + 1, "expected exactly one new POST");
    const sent = JSON.parse(posts[posts.length - 1].opts.body);
    assert.strictEqual(sent.profile, "main");
    assert.strictEqual(sent.kind, "image");
    assert.strictEqual(sent.prompt, "a cat in a hat");
    assert.strictEqual(sent.model, "nano2");
    assert.strictEqual(sent.aspect, "9:16");
    assert.strictEqual(sent.count, 1);
    assert.strictEqual(posts[posts.length - 1].opts.headers["X-Flow-Token"], "secret-token-123");
    assert.ok(el("fr-job-msg").textContent.includes("Job queued"), "job msg: " + el("fr-job-msg").textContent);
    assert.strictEqual(el("fr-prompt").value, "", "prompt not cleared after queue");
  });

  await check("job list renders done media + blocked warning; listing issues no POST", async () => {
    const postsBefore = fetchCalls.filter((c) => (c.opts && c.opts.method) === "POST").length;
    await panel.internals.refreshJobs();
    await flush(); await flush();
    const html = el("fr-jobs-list").innerHTML;
    assert.ok(html.includes("https://example.com/media/cat.png"), "media URL missing");
    assert.ok(html.includes("Open"), "Open link missing");
    assert.ok(html.includes("Copy URL"), "Copy URL button missing");
    assert.ok(html.includes("Download"), "Download button missing");
    assert.ok(html.includes("badge-done"), "done badge missing");
    assert.ok(html.includes("badge-blocked"), "blocked badge missing");
    assert.ok(html.includes("Do NOT resend"), "blocked warning missing");
    const postsAfter = fetchCalls.filter((c) => (c.opts && c.opts.method) === "POST").length;
    assert.strictEqual(postsAfter, postsBefore, "a POST was issued while listing jobs");
    assert.ok(Array.isArray(store.flowRemoteJobs) && store.flowRemoteJobs.length === 3,
      "job cache not saved to storage");
  });

  await check("beacon shows NOT RESPONDING when ping never answers, RUNNING again after", async () => {
    noPing = true;
    const state = await panel.internals.refreshBeacon();
    assert.strictEqual(state, "NOT RESPONDING");
    assert.ok(el("fr-bg-health").textContent.includes("NOT RESPONDING"),
      "beacon line: " + el("fr-bg-health").textContent);
    assert.ok(el("fr-bg-hint").textContent.includes("reload the page"),
      "beacon hint missing");
    noPing = false;
    const state2 = await panel.internals.refreshBeacon();
    assert.strictEqual(state2, "RUNNING");
  });

  await check("Enter/Escape inside the panel stop propagation (page editor never sees them)", () => {
    const p = el("fr-panel");
    const ev1 = p.dispatch("keydown", { key: "Enter" });
    assert.ok(ev1._stopped, "Enter keydown was not stopped");
    const ev2 = p.dispatch("keydown", { key: "Escape" });
    assert.ok(ev2._stopped, "Escape keydown was not stopped");
  });

  await check("floating button has drag listeners (pointer + touch, passive:false)", () => {
    const btn = el("fr-btn");
    assert.ok(btn._listeners.pointerdown && btn._listeners.pointerdown.length >= 1, "no pointerdown drag handler");
    assert.ok(btn._listeners.pointermove && btn._listeners.pointermove.length >= 1, "no pointermove drag handler");
    assert.ok(btn._listeners.touchstart && btn._listeners.touchstart.length >= 1, "no touchstart drag handler");
    assert.ok(btn._listeners.touchmove && btn._listeners.touchmove.length >= 1, "no touchmove drag handler");
    assert.strictEqual(btn.style.touchAction, "none", "button needs touch-action:none for drag");
  });

  // Close the panel so its 5 s poll timer does not keep node alive.
  try { if (panel.internals.isPanelOpen()) panel.internals.setPanelOpen(false); } catch (e) {}

  // ---- no-DOM load guard (must be last: it clears the globals) ----
  await check("content-panel.js loads in node with no DOM and no chrome (guarded, no throw)", () => {
    delete require.cache[require.resolve(path.join(EXT_DIR, "content-panel.js"))];
    delete global.document;
    delete global.window;
    delete global.chrome;
    require(path.join(EXT_DIR, "content-panel.js")); // returns early: no document
  });

  console.log("\n" + pass + " passed, " + fail + " failed.");
  if (fail) {
    console.log("Failures:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error("Test harness crashed:", e); process.exit(2); });
