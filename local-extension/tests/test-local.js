// Flow Local — node mock test for the v1.0.0 fill-only panel.
// NOT shipped in the extension ZIP. Run: node tests/test-local.js
// Uses a fake DOM + a mock flow.google.com project page + mocked
// chrome.storage. Covers the v1.0.0 brief's required cases:
//   1. panel injects (host on documentElement, floating button, hidden panel)
//   2. button toggles panel open/closed
//   3. kind switch swaps model lists + count/duration rows
//   4. Fill writes the prompt into the mock ProseMirror composer
//   5. settings apply calls the right page controls (model / aspect /
//      count / duration) and the summary read-back shows the new values
//   6. last-used values persist via mocked chrome.storage
//   7. no composer on the page -> Fill reports it plainly, nothing throws
// NEGATIVE assertions (the whole point of fill-only):
//   8. no fetch() / XHR / token / URL handling anywhere in the code
//   9. no .click() on Flow's Send/Generate button — the Send button's
//      click count stays 0 through every fill; the only .click() call
//      site in the source is tapSettingsControl(), called only with
//      settings controls.

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const EXT_DIR = path.join(__dirname, "..");

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

// ---------------------------------------------------------------------------
// Selector matcher: tag, .class, #id, [attr], [attr="v"], [attr*="v"]
// (with optional i flag), descendant combinator, comma lists, :checked.
// ---------------------------------------------------------------------------

function parseAttr(inner) {
  const m = inner.match(/^([a-zA-Z-]+)\s*(?:([*^$~|]?=)\s*"([^"]*)"\s*(i)?)?$/);
  if (!m) return null;
  return { name: m[1], op: m[2] || null, val: m[3] == null ? null : m[3], ci: !!m[4] };
}

function parseSimple(part) {
  let s = part;
  let checked = false;
  if (s.slice(-8) === ":checked") { checked = true; s = s.slice(0, -8); }
  const out = { tag: null, id: null, classes: [], attrs: [], checked };
  // Split into segments: tag, .class, #id, [attr...] — respecting quotes.
  let i = 0;
  const tagM = s.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagM) { out.tag = tagM[0]; i = tagM[0].length; }
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") {
      const m = s.slice(i + 1).match(/^[a-zA-Z0-9_-]+/);
      if (!m) return null;
      out.classes.push(m[0]);
      i += 1 + m[0].length;
    } else if (ch === "#") {
      const m = s.slice(i + 1).match(/^[a-zA-Z0-9_-]+/);
      if (!m) return null;
      out.id = m[0];
      i += 1 + m[0].length;
    } else if (ch === "[") {
      let depth = 0, j = i, inQ = false;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '"' && s[j - 1] !== "\\") inQ = !inQ;
        if (!inQ) {
          if (c === "[") depth++;
          if (c === "]") { depth--; if (depth === 0) break; }
        }
      }
      if (j >= s.length) return null;
      const attr = parseAttr(s.slice(i + 1, j));
      if (!attr) return null;
      out.attrs.push(attr);
      i = j + 1;
    } else {
      return null;
    }
  }
  return out;
}

function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, inQ = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inQ = !inQ;
    if (!inQ) {
      if (c === "[") depth++;
      if (c === "]") depth--;
    }
    if (!inQ && depth === 0 && c === sep) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function attrValue(el, name) {
  if (name === "name") return el.name || null;
  if (name === "type") return el.type || null;
  if (name === "value") return el.value || null;
  return el.getAttribute(name);
}

function matchesSimple(el, simple) {
  if (!el || !el.tagName) return false;
  if (simple.checked && !el.checked) return false;
  if (simple.tag && el.tagName.toLowerCase() !== simple.tag.toLowerCase()) return false;
  if (simple.id && el.id !== simple.id) return false;
  for (const c of simple.classes) {
    if (!el.classList || !el.classList.contains(c)) return false;
  }
  for (const a of simple.attrs) {
    const v = attrValue(el, a.name);
    if (a.op === null) {
      if (v === null || v === undefined) return false;
    } else if (a.op === "=") {
      if (v === null) return false;
      if (a.ci ? String(v).toLowerCase() !== a.val.toLowerCase() : String(v) !== a.val) return false;
    } else if (a.op === "*=") {
      if (v === null) return false;
      if (a.ci ? String(v).toLowerCase().indexOf(a.val.toLowerCase()) === -1
               : String(v).indexOf(a.val) === -1) return false;
    } else {
      return false;
    }
  }
  return true;
}

function matchesSelector(el, sel) {
  const groups = splitTopLevel(sel, ",");
  for (const g of groups) {
    const parts = splitTopLevel(g, " ").map(parseSimple);
    if (parts.some((p) => p === null)) continue;
    // Right-to-left descendant match.
    let cur = el;
    let ok = true;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (i === parts.length - 1) {
        if (!matchesSimple(cur, parts[i])) { ok = false; break; }
        cur = cur.parentNode;
      } else {
        let found = false;
        while (cur) {
          if (matchesSimple(cur, parts[i])) { found = true; cur = cur.parentNode; break; }
          cur = cur.parentNode;
        }
        if (!found) { ok = false; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

function FakeElement(tag) {
  this.tagName = String(tag || "div").toUpperCase();
  this.children = [];
  this.style = {};
  this.attributes = {};
  this._listeners = {};
  this._text = "";
  this._html = "";
  this._value = "";
  this.checked = false;
  this.selected = false;
  this.disabled = false;
  this.className = "";
  this.id = "";
  this.name = "";
  this.type = "";
  this.parentNode = null;
  this.parentElement = null;
  this.shadowRoot = null;
  this.host = null;
  this._visible = true;
  this._clickCount = 0;
  const self = this;
  this.classList = {
    contains: (c) => (self.className || "").split(/\s+/).indexOf(c) >= 0,
    add: (c) => { if (!self.classList.contains(c)) self.className = ((self.className || "") + " " + c).trim(); },
    remove: (c) => { self.className = (self.className || "").split(/\s+/).filter((x) => x !== c).join(" "); }
  };
}
Object.defineProperty(FakeElement.prototype, "value", {
  configurable: true,
  get: function () { return this._value || ""; },
  set: function (v) { this._value = String(v == null ? "" : v); }
});
FakeElement.prototype.appendChild = function (el) {
  el.parentNode = this;
  el.parentElement = this;
  this.children.push(el);
  return el;
};
FakeElement.prototype.remove = function () {
  if (this.parentNode) {
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
    this.parentElement = null;
  }
};
FakeElement.prototype.setAttribute = function (k, v) {
  this.attributes[k] = String(v);
  if (k === "id") this.id = String(v);
  if (k === "type") this.type = String(v);
  if (k === "class") this.className = String(v);
};
FakeElement.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
};
FakeElement.prototype.removeAttribute = function (k) { delete this.attributes[k]; };
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
FakeElement.prototype.dispatchEvent = function (ev) {
  if (!ev || !ev.type) return true;
  this.dispatch(ev.type, ev);
  return true;
};
FakeElement.prototype.click = function () {
  this._clickCount++;
  this.dispatch("click");
};
FakeElement.prototype.focus = function () {};
FakeElement.prototype.scrollIntoView = function () {};
FakeElement.prototype.select = function () {};
FakeElement.prototype.getBoundingClientRect = function () {
  return this._visible
    ? { width: 100, height: 40, left: 0, top: 0, right: 100, bottom: 40 }
    : { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
};
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
FakeElement.prototype.closest = function (sel) {
  let cur = this;
  while (cur) {
    if (matchesSelector(cur, sel)) return cur;
    cur = cur.parentNode;
  }
  return null;
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
  configurable: true,
  get: function () { return this._text; },
  set: function (v) { this._text = String(v == null ? "" : v); }
});
Object.defineProperty(FakeElement.prototype, "innerHTML", {
  configurable: true,
  get: function () { return this._html; },
  set: function (v) { this._html = String(v); this.children = []; }
});

function FakeEvent(type, init) {
  this.type = type;
  this.bubbles = !!(init && init.bubbles);
  this.cancelable = !!(init && init.cancelable);
  this.key = init && init.key;
  this.inputType = init && init.inputType;
  this.data = init && init.data;
  this._stopped = false;
}
FakeEvent.prototype.preventDefault = function () {};
FakeEvent.prototype.stopPropagation = function () { this._stopped = true; };

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
// Mock flow.google.com project page
// ---------------------------------------------------------------------------
// Simulates the live Flow DOM the fill logic drives:
// - flow-base-prompt-box > flow-rich-text-editor.prompt-input > ProseMirror
// - submit-controls: settings trigger + generate (Send) button + summary span
// - flow-prompt-box-settings popover (hidden until the trigger is tapped)
//   with model trigger, media toggles, aspect toggles, duration toggles,
//   count toggles, and a CDK-style model menu (button[role=menuitem]).
// Clicking a control updates the mock Flow state the way the real page
// would (toggle checked state, trigger text, summary span).

function buildMockFlowPage(opts) {
  opts = opts || {};
  const docEl = new FakeElement("html");
  const body = new FakeElement("body");
  docEl.appendChild(body);

  const state = {
    model: opts.model || "Nano Banana 2.1",
    aspect: opts.aspect || "16:9",
    count: opts.count || "x1",
    mediaMode: opts.mediaMode || "video",
    duration: "8s"
  };
  const updateSummary = () => {
    const crop = state.aspect.replace(":", "_");
    summary.textContent = "🍌 " + state.model + " crop_" + crop + " " + state.count;
  };

  const box = new FakeElement("flow-base-prompt-box");
  body.appendChild(box);

  const editor = new FakeElement("flow-rich-text-editor");
  editor.className = "prompt-input";
  box.appendChild(editor);
  const prose = new FakeElement("div");
  prose.className = "ProseMirror";
  prose.setAttribute("contenteditable", "true");
  editor.appendChild(prose);

  const controls = new FakeElement("div");
  controls.className = "submit-controls";
  box.appendChild(controls);
  const settingsBtn = new FakeElement("button");
  settingsBtn.className = "settings-trigger-button";
  controls.appendChild(settingsBtn);
  const genWrap = new FakeElement("flow-generate-icon-button");
  controls.appendChild(genWrap);
  const sendBtn = new FakeElement("button");
  sendBtn.className = "generate-icon-button";
  sendBtn.setAttribute("aria-label", "Start generation");
  sendBtn.disabled = true; // empty composer -> Send disabled (real Flow)
  genWrap.appendChild(sendBtn);
  const summary = new FakeElement("span");
  summary.className = "settings-summary";
  controls.appendChild(summary);
  updateSummary();

  // Composer input enables Send (real Flow behaviour, mocked).
  prose.addEventListener("input", () => { sendBtn.disabled = false; });

  // Settings popover (hidden until the trigger is tapped).
  const popover = new FakeElement("flow-prompt-box-settings");
  popover._visible = false;
  body.appendChild(popover);
  settingsBtn.addEventListener("click", () => { popover._visible = !popover._visible; });

  const modelTrig = new FakeElement("span");
  modelTrig.className = "model-select-trigger-content";
  modelTrig.textContent = state.model;
  const modelTrigBtn = new FakeElement("button");
  modelTrigBtn.appendChild(modelTrig);
  popover.appendChild(modelTrigBtn);

  const mediaGroup = [], aspectGroup = [], durationGroup = [], countGroup = [];
  function toggle(text, groupArr) {
    const wrap = new FakeElement("mat-button-toggle");
    const b = new FakeElement("button");
    b.textContent = text;
    b.addEventListener("click", () => {
      // Radio behaviour within the group: only this one stays checked.
      groupArr.forEach((other) => { if (other !== b) other.setAttribute("aria-checked", "false"); });
      b.setAttribute("aria-checked", "true");
    });
    wrap.appendChild(b);
    popover.appendChild(wrap);
    groupArr.push(b);
    return b;
  }
  toggle("Image", mediaGroup); toggle("Video", mediaGroup);
  ["9:16", "16:9", "1:1", "4:3", "3:4"].forEach((a) => toggle(a, aspectGroup));
  ["8s", "10s"].forEach((d) => toggle(d, durationGroup));
  ["x1", "x2", "x3", "x4"].forEach((c) => toggle(c, countGroup));
  const mediaToggles = mediaGroup;
  const aspectToggles = aspectGroup;
  const durationToggles = durationGroup;
  const countToggles = countGroup;

  // Initial checked states (as the mock page starts).
  const markChecked = (list, text) => {
    list.forEach((b) => { b.setAttribute("aria-checked", (b.textContent === text) ? "true" : "false"); });
  };
  markChecked(mediaToggles, state.mediaMode === "image" ? "Image" : "Video");
  markChecked(aspectToggles, state.aspect);
  markChecked(durationToggles, state.duration);
  markChecked(countToggles, state.count);

  // Keep the summary in sync when a toggle is tapped.
  aspectToggles.forEach((b) => b.addEventListener("click", () => { state.aspect = b.textContent; updateSummary(); }));
  countToggles.forEach((b) => b.addEventListener("click", () => { state.count = b.textContent; updateSummary(); }));
  durationToggles.forEach((b) => b.addEventListener("click", () => { state.duration = b.textContent; }));

  // Model menu (CDK overlay style): hidden until the trigger is tapped.
  const menuItems = [];
  ["Nano Banana Pro", "Nano Banana 2 Lite", "Nano Banana 2.1", "Imagen 4",
   "Veo 3.1 - Lite", "Veo 3.1 - Fast", "Omni 1.2 Flash"].forEach((label) => {
    const item = new FakeElement("button");
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item._visible = false;
    item.addEventListener("click", () => {
      state.model = label;
      modelTrig.textContent = label;
      updateSummary();
      menuItems.forEach((m) => { m._visible = false; });
    });
    body.appendChild(item);
    menuItems.push(item);
  });
  modelTrigBtn.addEventListener("click", () => {
    const anyVisible = menuItems.some((m) => m._visible);
    menuItems.forEach((m) => { m._visible = !anyVisible; });
  });

  return {
    documentElement: docEl,
    body,
    state,
    prose,
    sendBtn,
    settingsBtn,
    popover,
    summary,
    menuItems,
    toggles: { media: mediaToggles, aspect: aspectToggles, duration: durationToggles, count: countToggles }
  };
}

function makeDocument(page) {
  const selection = {
    _target: null,
    selectAllChildren: function (el) { this._target = el; },
    deleteFromDocument: function () { if (this._target) this._target.textContent = ""; }
  };
  return {
    documentElement: page ? page.documentElement : new FakeElement("html"),
    body: page ? page.body : new FakeElement("body"),
    readyState: "complete",
    createElement: function (tag) { return new FakeElement(tag); },
    createTextNode: function (text) {
      const n = new FakeElement("#text");
      n.textContent = text;
      return n;
    },
    addEventListener: function () {},
    dispatchEvent: function () { return true; },
    execCommand: function (cmd, ui, text) {
      if (cmd === "insertText" && selection._target) {
        selection._target.textContent = text;
        return true;
      }
      return true;
    },
    querySelector: function (sel) {
      return this.documentElement.querySelector(sel);
    },
    querySelectorAll: function (sel) {
      return this.documentElement.querySelectorAll(sel);
    },
    getElementById: function (id) { return this.documentElement.getElementById(id); },
    _selection: selection
  };
}

function installGlobals(page, store) {
  const doc = makeDocument(page);
  global.document = doc;
  global.window = {
    addEventListener: function () {},
    getSelection: function () { return doc._selection; },
    getComputedStyle: function () { return { display: "block", visibility: "visible" }; }
  };
  global.getComputedStyle = global.window.getComputedStyle;
  global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  global.InputEvent = FakeEvent;
  global.Event = FakeEvent;
  global.KeyboardEvent = FakeEvent;
  global.HTMLTextAreaElement = { prototype: {} };
  global.HTMLInputElement = { prototype: {} };
  const defineValueAccessor = (proto) => {
    Object.defineProperty(proto, "value", {
      configurable: true,
      get: function () { return this._value || ""; },
      set: function (v) { this._value = String(v == null ? "" : v); }
    });
  };
  defineValueAccessor(global.HTMLTextAreaElement.prototype);
  defineValueAccessor(global.HTMLInputElement.prototype);
  global.chrome = {
    storage: { local: makeStorageMock(store) },
    runtime: { lastError: undefined }
  };
  return doc;
}

function loadPanel() {
  delete require.cache[require.resolve(path.join(EXT_DIR, "content-local.js"))];
  return require(path.join(EXT_DIR, "content-local.js"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
  const src = fs.readFileSync(path.join(EXT_DIR, "content-local.js"), "utf8");
  // Code lines only (comments may name the forbidden things to explain
  // why they are absent).
  const codeLines = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l.trim()));
  const code = codeLines.join("\n");

  // ---- static checks ----
  await check("manifest v1.0.0: MV3, storage only, no background/popup/host_permissions", () => {
    assert.strictEqual(manifest.version, "1.0.0");
    assert.strictEqual(manifest.name, "Flow Local");
    assert.strictEqual(manifest.manifest_version, 3);
    assert.deepStrictEqual(manifest.permissions, ["storage"]);
    assert.ok(!("host_permissions" in manifest), "host_permissions must be absent (no network at all)");
    assert.ok(!("background" in manifest), "background must be absent (content script only)");
    assert.ok(!("action" in manifest), "action/popup must be absent (the panel is the UI)");
    assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1);
    const cs = manifest.content_scripts[0];
    assert.deepStrictEqual(cs.matches, ["*://flow.google.com/*"]);
    assert.deepStrictEqual(cs.js, ["content-local.js"],
      "content script must be the single self-contained content-local.js");
    assert.strictEqual(cs.run_at, "document_idle");
    for (const f of ["content-local.js"]) {
      assert.ok(fs.existsSync(path.join(EXT_DIR, f)), f + " missing");
    }
    for (const size of ["16", "48", "128"]) {
      assert.ok(fs.existsSync(path.join(EXT_DIR, "icons", "icon" + size + ".png")), "icon" + size + " missing");
    }
  });

  await check("NEGATIVE: no network of any kind — no fetch/XHR/server/URL handling", () => {
    assert.ok(!/fetch\s*\(/.test(code), "fetch( in code");
    assert.ok(!/XMLHttpRequest/.test(code), "XMLHttpRequest in code");
    assert.ok(!/sendMessage/.test(code), "chrome.runtime.sendMessage in code (no background)");
    assert.ok(!/webRequest/.test(code), "webRequest in code");
    assert.ok(!/storage\.session/.test(code), "storage.session in code");
    assert.ok(!/importScripts\s*\(/.test(code), "importScripts in code (single-file only)");
    assert.ok(!/app\.github\.dev/.test(code), "Codespace URL in code");
    assert.ok(!/localhost/.test(code), "localhost in code");
    assert.ok(!/X-Flow/.test(code), "auth header in code");
    assert.ok(!/\bserverUrl\b/.test(code), "serverUrl identifier in code");
    // A pairing code must never be stored or handled: no identifier or
    // property named token in code (prose like "walang token" in UI
    // strings does not count — only code shapes do).
    assert.ok(!/\.token\b/.test(code), ".token property in code");
    assert.ok(!/token\s*[:=]/.test(code), "token assignment in code");
    assert.ok(!/['"]token['"]/.test(code), "'token' key in code");
  });

  await check("NEGATIVE: the only .click() call site is tapSettingsControl()", () => {
    const clickLines = codeLines.filter((l) => /\.click\(\)/.test(l));
    assert.strictEqual(clickLines.length, 1,
      "expected exactly one .click() call site, found " + clickLines.length + ": " + clickLines.join(" | "));
    const fnStart = src.indexOf("function tapSettingsControl");
    assert.ok(fnStart >= 0, "tapSettingsControl missing");
    const fnEnd = src.indexOf("\n  }\n", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    assert.ok(/\.click\(\)/.test(fnBody), "the single .click() is not inside tapSettingsControl");
  });

  await check("NEGATIVE: tapSettingsControl is never called with a Send/Generate element", () => {
    const calls = [...code.matchAll(/tapSettingsControl\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert.ok(calls.length > 0, "no tapSettingsControl call sites found");
    for (const arg of calls) {
      assert.ok(!/send|generate/i.test(arg),
        "tapSettingsControl called with a Send/Generate argument: " + arg);
    }
  });

  await check("panel: no inline handlers, no injected <script>, no Object.prototype patch", () => {
    assert.ok(!/on(click|change|input|submit)\s*=/.test(code), "inline handler in content-local.js");
    assert.ok(!/<script/i.test(code), "<script> in content-local.js");
    assert.ok(!/Object\.prototype/.test(code), "Object.prototype patch in content-local.js");
    assert.ok(/all:?\s*["']?initial/.test(src), "host must use all: initial");
    assert.ok(src.includes("documentElement"), "shadow host must be on documentElement");
    assert.ok(src.includes("calc(100vw - 20px)"), "panel width must be calc(100vw - 20px)");
    assert.ok(src.includes("520px"), "panel max width 520px");
    assert.ok(src.includes("{ passive: false }") || src.includes("{passive:false}"),
      "drag touch handlers must use {passive:false}");
  });

  await check("panel tells the user plainly: fill-only, they tap Send themselves", () => {
    assert.ok(src.includes("Ikaw mismo ang pipindot ng Send") || src.includes("IKAW ang pipindot ng Send"),
      "panel lacks the Tagalog fill-only note");
    assert.ok(src.includes("Fill-only") || src.includes("Fill sa Flow"), "panel lacks Fill wording");
    assert.ok(!src.includes("Send job"), "panel must not have a Send-job button (fill-only)");
  });

  await check("model menu labels match current Flow (Nano Banana 2.1, not 2)", () => {
    assert.ok(src.includes('"Nano Banana 2.1"'), "nano2 must map to Nano Banana 2.1");
    assert.ok(!/"Nano Banana 2"(?![ .])/.test(code), "plain 'Nano Banana 2' must not appear as a menu label");
    assert.ok(src.includes('"Nano Banana Pro"'), "nano-pro label missing");
    assert.ok(src.includes('"Nano Banana 2 Lite"'), "nano2-lite label missing");
    assert.ok(src.includes('"Veo 3.1 - Lite"'), "veo-lite label missing");
    assert.ok(src.includes('"Omni 1.2 Flash"'), "omni-flash label missing");
  });

  // ---- runtime: full mock Flow page ----
  const store = {};
  const page = buildMockFlowPage({ model: "Nano Banana 2.1", aspect: "16:9", count: "x1", mediaMode: "video" });
  installGlobals(page, store);
  const panel = loadPanel();
  await flush(); await flush();

  const sr = panel.internals.getShadowRoot();
  const el = (id) => (sr ? sr.getElementById(id) : null);

  await check("panel injects: host on documentElement, floating button, panel hidden", () => {
    assert.ok(sr, "no shadow root");
    const host = global.document.documentElement.getElementById("fl-host");
    assert.ok(host, "host not appended to documentElement");
    assert.strictEqual(host.style.all, "initial", "host must use all: initial");
    const btn = el("fl-btn");
    assert.ok(btn, "floating button missing");
    assert.ok(btn.textContent.includes("Flow Local"), "button label wrong: " + btn.textContent);
    assert.strictEqual(btn.style.position, "fixed");
    assert.strictEqual(btn.style.bottom, "12px");
    const p = el("fl-panel");
    assert.ok(p, "panel missing");
    assert.strictEqual(p.style.display, "none", "panel must start hidden");
    assert.strictEqual(p.style.maxWidth, "520px");
    assert.ok(p.style.width.includes("calc(100vw - 20px)"), "panel width wrong: " + p.style.width);
  });

  await check("panel inputs are 16px (iOS zoom) with autocorrect off", () => {
    const prompt = el("fl-prompt");
    assert.ok(prompt, "prompt textarea missing");
    assert.strictEqual(prompt.style.fontSize, "16px", "prompt must be 16px");
  });

  await check("button toggles panel open then closed", () => {
    const btn = el("fl-btn");
    const p = el("fl-panel");
    btn.click();
    assert.strictEqual(p.style.display, "block", "panel did not open");
    assert.ok(panel.internals.isPanelOpen(), "panelOpen flag false after open");
    btn.click();
    assert.strictEqual(p.style.display, "none", "panel did not close");
    assert.ok(!panel.internals.isPanelOpen(), "panelOpen flag true after close");
    btn.click(); // leave open for the fill tests
    assert.strictEqual(p.style.display, "block");
  });

  await check("kind switch swaps model lists + count/duration rows", () => {
    const radios = sr.querySelectorAll('input[name="fl-kind"]');
    assert.strictEqual(radios.length, 2, "expected 2 kind radios");
    const img = radios.find((r) => r.value === "image");
    const vid = radios.find((r) => r.value === "video");
    // Starts on image (default).
    assert.deepStrictEqual(el("fl-model").children.map((o) => o.value),
      ["nano2", "nano2-lite", "nano-pro", "imagen4"]);
    assert.strictEqual(el("fl-count-row").style.display, "");
    vid.checked = true; img.checked = false;
    vid.dispatch("change");
    assert.deepStrictEqual(el("fl-model").children.map((o) => o.value),
      ["veo-lite", "veo-fast", "omni-flash"]);
    assert.strictEqual(el("fl-count-row").style.display, "none");
    assert.strictEqual(el("fl-duration-row").style.display, "");
    img.checked = true; vid.checked = false;
    img.dispatch("change");
    assert.deepStrictEqual(el("fl-model").children.map((o) => o.value),
      ["nano2", "nano2-lite", "nano-pro", "imagen4"]);
    assert.strictEqual(el("fl-count-row").style.display, "");
  });

  await check("Fill writes the prompt into the ProseMirror composer (image, nano-pro, 9:16, x2)", async () => {
    el("fl-prompt").value = "a cat in a hat";
    el("fl-model").value = "nano-pro";
    el("fl-aspect").value = "9:16";
    el("fl-count").value = "2";
    const sendClicksBefore = page.sendBtn._clickCount;
    el("fl-fill").click();
    // Fill + settings apply take ~3 s of real sleeps; wait for it.
    const start = Date.now();
    while (panel.internals.getFilling() && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 200));
    assert.ok(!panel.internals.getFilling(), "fill did not finish in 15 s");
    assert.strictEqual(page.prose.textContent, "a cat in a hat", "composer text wrong: " + JSON.stringify(page.prose.textContent));
    assert.strictEqual(page.sendBtn._clickCount, sendClicksBefore, "NEGATIVE: the Send button was clicked!");
    assert.strictEqual(page.sendBtn.disabled, false, "Send should be enabled after the prompt lands");
    const msg = el("fl-msg").textContent;
    assert.ok(msg.includes("Prompt nasa box na"), "fill msg missing prompt line: " + msg);
    assert.ok(msg.includes("Handa na"), "fill msg missing ready line: " + msg);
    assert.ok(msg.includes("Model:"), "fill msg missing model line: " + msg);
    assert.ok(msg.includes("Aspect:"), "fill msg missing aspect line: " + msg);
    assert.ok(msg.includes("Count:"), "fill msg missing count line: " + msg);
  });

  await check("settings apply drove the right page controls (model/aspect/count + read-back)", async () => {
    assert.strictEqual(page.state.model, "Nano Banana Pro", "model not applied on the page: " + page.state.model);
    assert.strictEqual(page.state.aspect, "9:16", "aspect not applied on the page: " + page.state.aspect);
    assert.strictEqual(page.state.count, "x2", "count not applied on the page: " + page.state.count);
    const rb = panel.internals.readFlowSettingsState();
    // The summary span carries the 🍌 emoji before the model label —
    // readFlowSettingsState (ported from v2.7.7) keeps it verbatim.
    assert.strictEqual(rb.model, "🍌 Nano Banana Pro", "read-back model wrong: " + rb.model);
    assert.strictEqual(rb.aspect, "9:16", "read-back aspect wrong: " + rb.aspect);
    assert.strictEqual(rb.outputs, "x2", "read-back outputs wrong: " + rb.outputs);
    assert.ok(el("fl-readback").textContent.includes("Nano Banana Pro"), "read-back line missing: " + el("fl-readback").textContent);
    assert.ok(el("fl-readback").textContent.includes("x2"), "read-back line missing outputs: " + el("fl-readback").textContent);
  });

  await check("last-used values persist to storage after fill", () => {
    const last = store.flowLocalLast;
    assert.ok(last, "flowLocalLast not saved");
    assert.strictEqual(last.prompt, "a cat in a hat");
    assert.strictEqual(last.modelKey, "nano-pro");
    assert.strictEqual(last.aspect, "9:16");
    assert.strictEqual(last.count, 2);
    assert.strictEqual(last.kind, "image");
    assert.ok(!("token" in (last || {})), "stored values must never include a token");
    assert.ok(!("serverUrl" in (last || {})), "stored values must never include a URL");
  });

  await check("video fill: omni-flash applies duration 10s; Send still never clicked", async () => {
    const radios = sr.querySelectorAll('input[name="fl-kind"]');
    const img = radios.find((r) => r.value === "image");
    const vid = radios.find((r) => r.value === "video");
    vid.checked = true; img.checked = false;
    vid.dispatch("change");
    el("fl-model").value = "omni-flash";
    el("fl-model").dispatch("change");
    assert.deepStrictEqual(el("fl-duration").children.map((o) => o.value), ["8", "10"],
      "omni-flash must offer 8s + 10s");
    el("fl-duration").value = "10";
    el("fl-prompt").value = "a dog surfing";
    el("fl-aspect").value = "16:9";
    const sendClicksBefore = page.sendBtn._clickCount;
    el("fl-fill").click();
    const start = Date.now();
    while (panel.internals.getFilling() && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 200));
    assert.ok(!panel.internals.getFilling(), "video fill did not finish in 15 s");
    assert.strictEqual(page.prose.textContent, "a dog surfing", "composer text wrong after video fill");
    assert.strictEqual(page.sendBtn._clickCount, sendClicksBefore, "NEGATIVE: the Send button was clicked on video fill!");
    assert.strictEqual(page.state.model, "Omni 1.2 Flash", "video model not applied: " + page.state.model);
    assert.strictEqual(page.state.duration, "10s", "duration 10s not applied: " + page.state.duration);
    const msg = el("fl-msg").textContent;
    assert.ok(msg.includes("Duration:"), "fill msg missing duration line: " + msg);
  });

  await check("textarea composer path: fillComposer writes via the native setter", async () => {
    const ta = new FakeElement("textarea");
    ta.setAttribute("placeholder", "What do you want to create?");
    ta._visible = true;
    const res = await panel.internals.fillComposer({ el: ta, kind: "textarea" }, "hello textarea");
    assert.ok(res.ok, "textarea fill failed: " + JSON.stringify(res));
    assert.strictEqual(ta.value, "hello textarea", "textarea value wrong: " + JSON.stringify(ta.value));
  });

  await check("Enter/Escape inside the panel stop propagation (page editor never sees them)", () => {
    const p = el("fl-panel");
    const ev1 = p.dispatch("keydown", { key: "Enter" });
    assert.ok(ev1._stopped, "Enter keydown was not stopped");
    const ev2 = p.dispatch("keydown", { key: "Escape" });
    assert.ok(ev2._stopped, "Escape keydown was not stopped");
  });

  await check("floating button has drag listeners (pointer + touch, passive:false)", () => {
    const btn = el("fl-btn");
    assert.ok(btn._listeners.pointerdown && btn._listeners.pointerdown.length >= 1, "no pointerdown drag handler");
    assert.ok(btn._listeners.pointermove && btn._listeners.pointermove.length >= 1, "no pointermove drag handler");
    assert.ok(btn._listeners.touchstart && btn._listeners.touchstart.length >= 1, "no touchstart drag handler");
    assert.ok(btn._listeners.touchmove && btn._listeners.touchmove.length >= 1, "no touchmove drag handler");
    assert.strictEqual(btn.style.touchAction, "none", "button needs touch-action:none for drag");
  });

  // ---- runtime: page with NO composer ----
  await check("no composer on the page: Fill reports it plainly, nothing throws, Send untouched", async () => {
    const store2 = {};
    const page2 = buildMockFlowPage({});
    // Remove the composer from the mock page.
    page2.prose.remove();
    // The textarea fallback must not find anything either: the mock page
    // has no textareas at all.
    installGlobals(page2, store2);
    const panel2 = loadPanel();
    await flush(); await flush();
    const sr2 = panel2.internals.getShadowRoot();
    const el2 = (id) => (sr2 ? sr2.getElementById(id) : null);
    const sendClicksBefore = page2.sendBtn._clickCount;
    el2("fl-prompt").value = "nothing to fill into";
    el2("fl-fill").click();
    const start = Date.now();
    while (panel2.internals.getFilling() && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 200));
    assert.ok(!panel2.internals.getFilling(), "fill did not finish in 15 s");
    assert.ok(el2("fl-msg").textContent.includes("Walang composer"),
      "expected the no-composer message, got: " + el2("fl-msg").textContent);
    assert.strictEqual(page2.sendBtn._clickCount, sendClicksBefore, "NEGATIVE: Send clicked with no composer!");
  });

  // ---- no-DOM load guard (must be last: it clears the globals) ----
  await check("content-local.js loads in node with no DOM and no chrome (guarded, no throw)", () => {
    delete require.cache[require.resolve(path.join(EXT_DIR, "content-local.js"))];
    delete global.document;
    delete global.window;
    delete global.chrome;
    delete global.localStorage;
    delete global.InputEvent;
    delete global.Event;
    delete global.KeyboardEvent;
    require(path.join(EXT_DIR, "content-local.js")); // returns early: no document
  });

  console.log("\n" + pass + " passed, " + fail + " failed.");
  if (fail) {
    console.log("Failures:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error("Test harness crashed:", e); process.exit(2); });
