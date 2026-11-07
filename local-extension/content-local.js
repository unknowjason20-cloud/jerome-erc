// Flow Local — content-local.js (v1.0.0)
// Fill-only Orion iOS extension for Google Flow. It fills your prompt and
// settings (model, aspect, count, duration) into Flow's own composer on
// flow.google.com, and then YOU tap Flow's own Send button yourself.
//
// What it does NOT do (by design):
// - No server, no pairing code, no terminal, no network requests of any
//   kind. It never contacts anything outside this page.
// - It NEVER taps Send / Generate / Start generation. Scripted Send is
//   dead on real Flow (trusted-gesture / reCAPTCHA gate, hardened Sep
//   2026) — the only .click() in this file lives in tapSettingsControl(),
//   which is called ONLY with Flow's settings controls (settings trigger,
//   model trigger, menu items, toggles, radios). The Send button is only
//   ever READ (is it enabled yet?) so the panel can tell you it is ready.
// - No photo attach in v1.0.0 (the picker-first DataTransfer path from
//   Flow Auto v2.7.7 was never live-verified; attach the photo in Flow's
//   own picker yourself).
//
// Fill + settings logic is ported from Flow Auto v2.7.7 (userscript),
// whose selectors were LIVE-VERIFIED on flow.google.com (Nano Banana
// Pro, 9:16, x1). Panel shell is ported from Flow Remote v1.1.1
// content-panel.js (floating button + Shadow-DOM panel, proven on Orion
// iOS). Single file on purpose: Orion iOS failed to load the two-file
// content-script entry in v1.1.0, and importScripts() aborts a whole file
// on Orion — so there are no cross-file globals, no importScripts, and
// no background script at all. Every chrome.* call is guarded.

(function () {
  "use strict";

  // ---------- model / aspect tables ----------
  // menu = the exact label in Flow's model menu (Nov 2026: plain
  // "Nano Banana 2" is gone — it is 2.1 / 2 Lite / Pro now).
  var IMAGE_MODELS = [
    { value: "nano2", label: "Nano Banana 2.1", menu: "Nano Banana 2.1" },
    { value: "nano2-lite", label: "Nano Banana 2 Lite", menu: "Nano Banana 2 Lite" },
    { value: "nano-pro", label: "Nano Banana Pro", menu: "Nano Banana Pro" },
    { value: "imagen4", label: "Imagen 4", menu: "Imagen 4" }
  ];
  var VIDEO_MODELS = [
    { value: "veo-lite", label: "Veo 3.1 - Lite", menu: "Veo 3.1 - Lite" },
    { value: "veo-fast", label: "Veo 3.1 - Fast", menu: "Veo 3.1 - Fast" },
    { value: "omni-flash", label: "Omni 1.2 Flash", menu: "Omni 1.2 Flash" }
  ];
  var IMAGE_ASPECTS = ["9:16", "16:9", "1:1", "4:3", "3:4"];
  var VIDEO_ASPECTS = ["9:16", "16:9"];
  var COUNTS = ["x1", "x2", "x3", "x4"];

  // Flow Auto v2.7.7 selectors (live-verified on flow.google.com).
  var SEL = {
    composerProseMirror: [
      { sel: "flow-rich-text-editor.prompt-input div.ProseMirror", via: "flow-rich-text-editor.prompt-input div.ProseMirror" },
      { sel: "flow-rich-text-editor div.ProseMirror", via: "flow-rich-text-editor div.ProseMirror" },
      { sel: 'div.ProseMirror[contenteditable="true"]', via: "div.ProseMirror[contenteditable]" },
      { sel: "flow-rich-text-editor [contenteditable=\"true\"]", via: "flow-rich-text-editor [contenteditable]" }
    ],
    generate: [
      { sel: "flow-generate-icon-button button.generate-icon-button", via: "flow-generate-icon-button button.generate-icon-button" },
      { sel: "button.generate-icon-button", via: "button.generate-icon-button" }
    ],
    settingsTrigger: "flow-base-prompt-box div.submit-controls button.settings-trigger-button, button.settings-trigger-button",
    agentChip: "flow-agent-mode-toggle-chip button.agent-mode-chip",
    composerAgent: [
      { sel: 'textarea[placeholder*="What do you want to create"]', via: "textarea[placeholder*=What do you want to create]" },
      { sel: 'textarea[aria-label*="What do you want to create" i]', via: "textarea[aria-label*=What do you want to create]" },
      { sel: '[contenteditable="true"][aria-label*="prompt" i]', via: "contenteditable[aria-label*=prompt]" },
      { sel: '[contenteditable="true"][data-placeholder*="prompt" i]', via: "contenteditable[data-placeholder*=prompt]" },
      { sel: 'textarea[aria-label*="prompt" i]', via: "textarea[aria-label*=prompt]" },
      { sel: 'textarea[placeholder*="prompt" i]', via: "textarea[placeholder*=prompt]" },
      { sel: '[contenteditable="true"]', via: "contenteditable (first visible)" }
    ],
    send: [
      { sel: 'button[aria-label*="Start generation" i]', via: "button[aria-label*=Start generation]" },
      { sel: 'button[aria-label*="send" i]', via: "button[aria-label*=send]" },
      { sel: 'button[aria-label*="generate" i]', via: "button[aria-label*=generate]" },
      { sel: "button[type=\"submit\"]", via: "button[type=submit]" }
    ],
    menuItemRadio: '[role="menuitemradio"]',
    menuItem: '[role="menuitem"]',
    radio: '[role="radio"]'
  };

  // Double-injection guard (Orion may run content scripts twice).
  try {
    if (window.__flowLocalInstalled) return;
    window.__flowLocalInstalled = true;
  } catch (e) {}

  var FILL_WAIT_MS = 600;

  // ---------- tiny utils ----------

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function normText(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function step(ok, note) { return { ok: !!ok, note: note || "" }; }

  // ---------- page DOM helpers (ported from Flow Auto v2.7.7) ----------

  function $q(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function $$q(sel, root) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.closest && el.closest("#fl-host")) return false; // never our own panel
    try { if (el.closest && el.closest("[hidden]")) return false; } catch (e) {}
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    try {
      var cs = (typeof window !== "undefined" && window.getComputedStyle) ? window.getComputedStyle(el) : null;
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    } catch (e) {}
    return true;
  }

  function buttonsByLigature(ligature, root) {
    var out = [];
    $$q("button", root || document).forEach(function (b) {
      var icons = b.querySelectorAll ? b.querySelectorAll("mat-icon") : [];
      for (var i = 0; i < icons.length; i++) {
        if ((icons[i].textContent || "").trim() === ligature) { out.push(b); break; }
      }
      if (!out.length || out[out.length - 1] !== b) {
        if ((b.textContent || "").trim() === ligature) out.push(b);
      }
    });
    return out.filter(isVisible);
  }

  function findByLigature(ligature, root) {
    var list = buttonsByLigature(ligature, root);
    return list.length ? list[0] : null;
  }

  function buttonDisabled(b) {
    if (!b) return true;
    if (b.disabled) return true;
    if (b.getAttribute && b.getAttribute("aria-disabled") === "true") return true;
    if (b.classList && b.classList.contains("mat-mdc-button-disabled")) return true;
    return false;
  }

  function isToggleChecked(b) {
    if (!b) return false;
    if (b.getAttribute && (b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true")) return true;
    if (b.classList && (b.classList.contains("mat-button-toggle-checked") || b.classList.contains("active") || b.classList.contains("selected"))) return true;
    var p = b.closest ? b.closest("mat-button-toggle") : null;
    if (p) {
      if (p.classList.contains("mat-button-toggle-checked")) return true;
      if (p.getAttribute && p.getAttribute("aria-checked") === "true") return true;
    }
    return false;
  }

  function searchVisible(sel, root) {
    var out = $$q(sel, root).filter(isVisible);
    if (out.length) return out;
    if (root && root !== document) return $$q(sel).filter(isVisible);
    return out;
  }

  // THE ONLY place a page element is ever .click()ed — and only with
  // Flow's SETTINGS controls (settings trigger, model trigger, menu
  // items, toggles, radios). NEVER called with Flow's Send/Generate
  // button: the Send check below only READS that button (disabled
  // state), it never clicks it. Any future caller must keep it that way.
  function tapSettingsControl(elx) {
    if (!elx) return;
    try { elx.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {}
    try { elx.focus(); } catch (e) {}
    try { elx.click(); } catch (e) {}
  }

  // ---------- composer finders (ported from Flow Auto v2.7.7) ----------

  function findProseMirrorComposer() {
    for (var i = 0; i < SEL.composerProseMirror.length; i++) {
      var cands = $$q(SEL.composerProseMirror[i].sel).filter(isVisible);
      if (cands.length) {
        var elx = cands[0];
        var agent = !!(elx.closest && elx.closest("flow-creative-agent-prompt-box"));
        return { el: elx, kind: "prosemirror", composerType: agent ? "agent-only?" : "classic", via: SEL.composerProseMirror[i].via };
      }
    }
    return null;
  }

  function classifyComposer(elx) {
    if (elx && elx.classList && elx.classList.contains("ProseMirror")) {
      if (elx.closest) {
        if (elx.closest("flow-creative-agent-prompt-box")) return "video";
        if (elx.closest('[class*="character" i]')) return "character";
        if (elx.closest('[class*="scene" i]')) return "scene";
      }
      return "video";
    }
    var ph = (elx.getAttribute("placeholder") || "") + " " + (elx.getAttribute("aria-label") || "");
    if (/describe your character/i.test(ph)) return "character";
    if (/select a clip/i.test(ph)) return "scene";
    if (/what do you want to create/i.test(ph)) return "video";
    return null;
  }

  // Flow Local only fills the project-page composer (video + image both
  // live on a project page). Character creator / scene editor are out of
  // scope for v1.0.0 — if no composer is found the panel says so plainly.
  function composerListForMode(mode) {
    return SEL.composerAgent;
  }

  function findComposerIn(list, mode) {
    for (var i = 0; i < list.length; i++) {
      var cands = $$q(list[i].sel).filter(isVisible);
      if (cands.length) {
        var elx = cands[0];
        var kind = (elx.tagName === "TEXTAREA" || elx.tagName === "INPUT") ? "textarea" : "contenteditable";
        var container = elx.closest("div") || elx.parentElement;
        var ctx = container ? (container.textContent || "") : "";
        var composerType = /agent/i.test(ctx.slice(0, 300)) ? "agent-only?" : "classic";
        return { el: elx, kind: kind, composerType: composerType, via: list[i].via };
      }
    }
    var all = $$q("textarea").filter(isVisible);
    for (var j = 0; j < all.length; j++) {
      if (classifyComposer(all[j]) === mode) {
        return { el: all[j], kind: "textarea", composerType: "classic", via: "textarea (classified: " + mode + ")" };
      }
    }
    return null;
  }

  function findComposerForMode(mode) {
    var pm = findProseMirrorComposer();
    if (pm) return { comp: pm, mode: mode, otherMode: null };
    var comp = findComposerIn(composerListForMode(mode), mode);
    if (comp) return { comp: comp, mode: mode, otherMode: null };
    return { comp: null, mode: mode, otherMode: null };
  }

  function findComposer() {
    var r = findComposerForMode("video");
    return r.comp;
  }

  // ---------- Send button: READ-ONLY (never clicked) ----------

  function findSendButton(composer) {
    var scopes = [];
    if (composer && composer.el && composer.el.closest) {
      var box = composer.el.closest("flow-base-prompt-box") || composer.el.closest("flow-prompt-box") || composer.el.closest("flow-creative-agent-prompt-box");
      if (box) scopes.push(box);
    }
    scopes.push(document);
    for (var s = 0; s < scopes.length; s++) {
      var scope = scopes[s];
      for (var i = 0; i < SEL.generate.length; i++) {
        var cands = $$q(SEL.generate[i].sel, scope).filter(isVisible);
        if (cands.length) return { el: cands[0], via: SEL.generate[i].via };
      }
      var lig = findByLigature("arrow_forward", scope);
      if (lig) return { el: lig, via: "mat-icon arrow_forward" };
      for (var j = 0; j < SEL.send.length; j++) {
        var c2 = $$q(SEL.send[j].sel, scope).filter(isVisible);
        if (c2.length) return { el: c2[0], via: SEL.send[j].via };
      }
    }
    var btns = $$q("button").filter(isVisible);
    for (var k = 0; k < btns.length; k++) {
      if (/^\s*(generate|create|send)\s*$/i.test(btns[k].textContent || "")) return { el: btns[k], via: 'button text "' + (btns[k].textContent || "").trim() + '"' };
    }
    return null;
  }

  function isFlowSendEnabled(composer) {
    var send = findSendButton(composer);
    if (!send || !send.el) return false;
    return !buttonDisabled(send.el);
  }

  // ---------- fill (ported from Flow Auto v2.7.7) ----------

  function fillTextareaLike(elm, text) {
    try {
      var proto = elm.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(elm, text);
      elm.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }

  function fillContentEditable(elm, text) {
    try { elm.focus(); } catch (e) {}
    try {
      var sel = window.getSelection();
      if (sel) { sel.selectAllChildren(elm); }
      if (document.execCommand("insertText", false, text)) return true;
    } catch (e) {}
    try {
      elm.textContent = text;
      elm.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      elm.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "insertText", data: text }));
      return true;
    } catch (e) { return false; }
  }

  // ProseMirror injection (Flow Auto v2.2.0): focus, clean slate,
  // execCommand('selectAll') + insertText, then a native InputEvent.
  // execCommand is deprecated but still the path ProseMirror listens to;
  // the textContent fallback covers Safari builds where insertText
  // returns false.
  function fillProseMirror(elm, text) {
    try { elm.focus(); } catch (e) {}
    try { elm.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>'; } catch (e) {}
    var ok = false;
    try {
      var sel = window.getSelection();
      if (sel) sel.selectAllChildren(elm);
      if (document.execCommand("insertText", false, text)) ok = true;
    } catch (e) {}
    if (!ok || (elm.textContent || "").trim().length === 0) {
      try {
        elm.focus();
        var sel2 = window.getSelection();
        if (sel2) { sel2.selectAllChildren(elm); sel2.deleteFromDocument(); }
        var p = elm.querySelector("p") || elm;
        p.textContent = text;
        elm.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
        elm.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "insertText", data: text }));
        ok = true;
      } catch (e) { ok = false; }
    } else {
      try { elm.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text })); } catch (e) {}
    }
    return ok;
  }

  function composerText(comp) {
    if (!comp || !comp.el) return "";
    if (comp.kind === "contenteditable" || comp.kind === "prosemirror") return (comp.el.textContent || "");
    return (comp.el.value || "");
  }

  async function fillComposer(comp, text) {
    var ok = false; var method = "";
    if (comp.kind === "prosemirror") {
      ok = fillProseMirror(comp.el, text); method = "ProseMirror execCommand insertText";
    } else if (comp.kind === "contenteditable") {
      ok = fillContentEditable(comp.el, text); method = "insertText";
      if (!ok || !isFlowSendEnabled(comp)) {
        ok = fillContentEditable(comp.el, text); method = "textContent+input events";
      }
    } else {
      ok = fillTextareaLike(comp.el, text); method = "native setter + input event";
      if (!ok) { try { comp.el.value = text; comp.el.dispatchEvent(new Event("input", { bubbles: true })); ok = true; method = "plain value set (fallback)"; } catch (e) { ok = false; } }
    }
    await sleep(FILL_WAIT_MS);
    var filled = (composerText(comp).trim().length > 0);
    var sendEnabled = isFlowSendEnabled(comp);
    if (ok && filled) return { ok: true, method: method, filled: true, sendEnabled: sendEnabled };
    if (ok && !filled) return { ok: false, method: method, filled: false, sendEnabled: sendEnabled, reason: "the box still looks empty after filling" };
    return { ok: false, method: method, filled: filled, sendEnabled: sendEnabled, reason: 'fill method "' + method + '" did not take effect' };
  }

  // ---------- settings (ported from Flow Auto v2.7.7) ----------
  // Every function here only touches Flow's SETTINGS controls, via
  // tapSettingsControl(). A step that cannot be applied leaves Flow's
  // setting as it was and says so — it never blocks the fill.

  function findAgentChip() {
    var b = $q(SEL.agentChip);
    if (b && isVisible(b)) return b;
    var alt = $$q('button[aria-label*="Agent instructions" i]').filter(isVisible);
    if (alt.length) return alt[0];
    var byText = $$q("button").filter(isVisible);
    for (var i = 0; i < byText.length; i++) {
      if ((byText[i].textContent || "").trim().toLowerCase() === "agent instructions") return byText[i];
    }
    return null;
  }

  function ensureAgentModeOff() {
    try {
      var btn = findAgentChip();
      if (btn && (btn.classList.contains("agent-mode-chip-checked") || btn.getAttribute("aria-pressed") === "true")) {
        tapSettingsControl(btn);
        return true;
      }
    } catch (e) {}
    return false;
  }

  function findComposerFooterSettings(comp) {
    if (!comp || !comp.el) return null;
    var trig = $q(SEL.settingsTrigger);
    if (trig && isVisible(trig)) return trig;
    var node = comp.el;
    for (var i = 0; i < 7 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      var b = $q('button[aria-label="Settings"]', node);
      if (b && isVisible(b)) return b;
    }
    return null;
  }

  function findSettingsPopover() {
    var p = $q("flow-prompt-box-settings");
    return (p && isVisible(p)) ? p : null;
  }

  async function openSettingsPopover(settingsBtn) {
    var pop = findSettingsPopover();
    if (pop) return pop;
    if (!settingsBtn) return null;
    tapSettingsControl(settingsBtn);
    var start = Date.now();
    while (Date.now() - start < 5000) { pop = findSettingsPopover(); if (pop) break; await sleep(400); }
    if (!pop) return null;
    var cStart = Date.now();
    while (Date.now() - cStart < 5000) {
      if ($q("span.model-select-trigger-content", pop) || $$q("mat-button-toggle button", pop).length) break;
      await sleep(300);
    }
    await sleep(300);
    return pop;
  }

  async function closeSettingsPopover(settingsBtn) {
    if (!findSettingsPopover()) return true;
    await sleep(250);
    if (settingsBtn) tapSettingsControl(settingsBtn);
    else { try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); } catch (e) {} }
    var start = Date.now();
    while (Date.now() - start < 3000) { if (!findSettingsPopover()) break; await sleep(300); }
    if (findSettingsPopover()) {
      try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); } catch (e) {}
      await sleep(400);
    }
    return !findSettingsPopover();
  }

  async function selectMediaModeInPopover(popover, wantImage) {
    var lig = wantImage ? "image" : "videocam";
    var b = (buttonsByLigature(lig, popover).length ? buttonsByLigature(lig, popover)[0] : null) ||
            (buttonsByLigature(lig, document).length ? buttonsByLigature(lig, document)[0] : null);
    if (!b) {
      var toggles = $$q("mat-button-toggle button", popover).concat($$q("mat-button-toggle button", document));
      for (var i = 0; i < toggles.length; i++) {
        var t = (toggles[i].textContent || "").trim().toLowerCase();
        if (wantImage ? t === "image" : t === "video") { b = toggles[i]; break; }
      }
    }
    if (!b) {
      var all = $$q("button", popover).concat($$q("button", document)).filter(isVisible);
      for (var k = 0; k < all.length; k++) {
        var tk = (all[k].textContent || "").trim().toLowerCase();
        if (wantImage ? tk === "image" : tk === "video") { b = all[k]; break; }
      }
    }
    if (!b) return step(false, "no " + (wantImage ? "Image" : "Video") + " toggle found in Flow's settings");
    if (isToggleChecked(b)) return step(true, "already in " + (wantImage ? "Image" : "Video") + " mode");
    tapSettingsControl(b);
    var parent = b.closest ? b.closest("mat-button-toggle") : null;
    if (parent && !isToggleChecked(b)) tapSettingsControl(parent);
    await sleep(400);
    var ok = isToggleChecked(b);
    return step(ok, ok ? "switched to " + (wantImage ? "Image" : "Video") + " mode" : "tapped the toggle but it did not stay selected");
  }

  function findModelMenuItems() {
    var items = $$q('flow-menu-item button[role="menuitem"], button[role="menuitem"]').filter(isVisible);
    if (items.length) return items;
    var overlay = $$q("div.cdk-overlay-pane button, div.mat-mdc-menu-content button, flow-menu-item button").filter(isVisible);
    return overlay.filter(function (b) {
      var t = (b.textContent || "").trim();
      return /Nano|Banana|Veo|Omni|Imagen/.test(t) && t.length < 60;
    });
  }

  async function selectModelInPopover(popover, modelLabel) {
    var trig = $q("span.model-select-trigger-content", popover) || $q("span.model-select-trigger-content");
    if (!trig) return step(false, "model picker trigger not found in Flow's settings");
    var cur = (trig.textContent || "").trim();
    if (cur && normText(cur) === normText(modelLabel)) return step(true, 'Flow already has model "' + cur + '"');
    var trigBtn = trig.closest ? (trig.closest("button") || trig) : trig;
    tapSettingsControl(trigBtn);
    await sleep(400);
    var items = [], start = Date.now();
    while (Date.now() - start < 4000) {
      items = findModelMenuItems();
      if (items.length) break;
      await sleep(300);
    }
    if (!items.length) {
      tapSettingsControl(trigBtn);
      await sleep(600);
      items = findModelMenuItems();
    }
    if (!items.length) return step(false, "model menu did not open after tapping the model picker");
    var target = normText(modelLabel), hit = null, i;
    for (i = 0; i < items.length; i++) { if (normText(items[i].textContent) === target) { hit = items[i]; break; } }
    if (!hit) {
      for (i = 0; i < items.length; i++) {
        var n = normText(items[i].textContent);
        if (n && (n.indexOf(target) !== -1 || target.indexOf(n) !== -1)) { hit = items[i]; break; }
      }
    }
    if (!hit) {
      var avail = items.map(function (x) { return (x.textContent || "").trim(); }).filter(Boolean).slice(0, 12);
      try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })); } catch (e) {}
      return step(false, 'Flow\u2019s model menu does not contain "' + modelLabel + '". Available: ' + avail.join(", "));
    }
    tapSettingsControl(hit);
    await sleep(350);
    return step(true, "Flow model picked: " + modelLabel);
  }

  async function selectAspectInPopover(popover, aspect) {
    var ligMap = { "16:9": "crop_16_9", "9:16": "crop_9_16", "4:3": "crop_landscape", "1:1": "crop_square" };
    var lig = ligMap[aspect];
    var b = null;
    if (lig) b = (buttonsByLigature(lig, popover).length ? buttonsByLigature(lig, popover)[0] : null) ||
                 (buttonsByLigature(lig, document).length ? buttonsByLigature(lig, document)[0] : null);
    if (!b) {
      var toggles = $$q("mat-button-toggle button", popover).concat($$q("mat-button-toggle button", document));
      for (var i = 0; i < toggles.length; i++) { if ((toggles[i].textContent || "").trim() === aspect) { b = toggles[i]; break; } }
    }
    if (!b) {
      var radios = $$q('[role="radio"]', popover).concat($$q('[role="radio"]', document)).filter(isVisible);
      for (var r = 0; r < radios.length; r++) {
        var rt = ((radios[r].getAttribute("aria-label") || "") + " " + (radios[r].textContent || "")).toLowerCase();
        if (rt.indexOf(aspect.toLowerCase()) !== -1) { b = radios[r]; break; }
      }
      if (b) {
        if (b.getAttribute("aria-checked") === "true") return step(true, "aspect is already " + aspect + " in Flow");
        tapSettingsControl(b);
        await sleep(300);
        var rok = b.getAttribute("aria-checked") === "true";
        return step(rok, rok ? "aspect set to " + aspect + " in Flow (radiogroup)" : "tapped aspect " + aspect + " (radiogroup) but it did not stay selected");
      }
    }
    if (!b) return step(false, 'aspect "' + aspect + '" was not found in Flow\u2019s settings — model was set, aspect left as Flow had it');
    if (isToggleChecked(b)) return step(true, "aspect is already " + aspect + " in Flow");
    tapSettingsControl(b);
    var parent = b.closest ? b.closest("mat-button-toggle") : null;
    if (parent && !isToggleChecked(b)) tapSettingsControl(parent);
    await sleep(300);
    var ok = isToggleChecked(b);
    return step(ok, ok ? "aspect set to " + aspect + " in Flow" : "tapped aspect " + aspect + " but it did not stay selected");
  }

  async function selectDurationInPopover(popover, secs) {
    var num = String(secs);
    var toggles = $$q("flow-prompt-box-settings mat-button-toggle button, mat-button-toggle button", popover);
    var hit = null;
    for (var i = 0; i < toggles.length; i++) {
      var t = (toggles[i].textContent || "").trim().toLowerCase();
      if (t === num + "s" || t === num + " dtk" || t.indexOf(num) === 0) { hit = toggles[i]; break; }
    }
    if (!hit) return step(false, "duration " + num + "s was not offered for this model in Flow's settings");
    if (isToggleChecked(hit)) return step(true, "duration is already " + num + "s");
    tapSettingsControl(hit); await sleep(300);
    var ok = isToggleChecked(hit);
    return step(ok, ok ? "duration set to " + num + "s" : "tapped duration " + num + "s but it did not stay selected");
  }

  // NEW in v1.0.0 (Flow Auto v2.7.7 only read the count back, never set
  // it): the settings popover offers x1–x4. Same shape as the duration
  // picker — toggle text "xN", radiogroup fallback. If Flow does not
  // offer it on this page, the count is left as Flow had it.
  async function selectCountInPopover(popover, count) {
    var want = "x" + String(count);
    var toggles = $$q("flow-prompt-box-settings mat-button-toggle button, mat-button-toggle button", popover);
    var hit = null;
    for (var i = 0; i < toggles.length; i++) {
      if ((toggles[i].textContent || "").trim().toLowerCase() === want) { hit = toggles[i]; break; }
    }
    if (!hit) {
      var radios = $$q('[role="radio"]', popover).concat($$q('[role="radio"]', document)).filter(isVisible);
      for (var r = 0; r < radios.length; r++) {
        var rt = ((radios[r].getAttribute("aria-label") || "") + " " + (radios[r].textContent || "")).toLowerCase();
        if (rt.indexOf(want) !== -1) { hit = radios[r]; break; }
      }
      if (hit) {
        if (hit.getAttribute("aria-checked") === "true") return step(true, "count is already " + want);
        tapSettingsControl(hit);
        await sleep(300);
        var rok = hit.getAttribute("aria-checked") === "true";
        return step(rok, rok ? "count set to " + want + " in Flow (radiogroup)" : "tapped count " + want + " (radiogroup) but it did not stay selected");
      }
    }
    if (!hit) return step(false, "count " + want + " was not offered for this model in Flow's settings — count left as Flow had it");
    if (isToggleChecked(hit)) return step(true, "count is already " + want);
    tapSettingsControl(hit); await sleep(300);
    var ok = isToggleChecked(hit);
    return step(ok, ok ? "count set to " + want + " in Flow" : "tapped count " + want + " but it did not stay selected");
  }

  // Read what Flow itself thinks the settings are — no clicking needed.
  // The summary span on the settings trigger reads like
  // "Nano Banana Pro crop_9_16 x1" = model label + crop + output count.
  function readFlowSettingsState() {
    var out = { stored: null, summary: "", model: "", aspect: "", outputs: "" };
    try { var raw = localStorage.getItem("FLOW_MAIN_PROMPT_BOX_STATE"); if (raw) out.stored = JSON.parse(raw); } catch (e) {}
    try { var sum = $q("span.settings-summary"); if (sum) out.summary = (sum.textContent || "").trim(); } catch (e) {}
    if (out.summary) {
      var m = out.summary.match(/crop_(\d+)_(\d+)/);
      if (m) out.aspect = m[1] + ":" + m[2];
      var x = out.summary.match(/\bx(\d+)\b/);
      if (x) out.outputs = "x" + x[1];
      var idx = out.summary.indexOf("crop_");
      out.model = (idx > 0 ? out.summary.slice(0, idx) : out.summary).replace(/\s+/g, " ").trim();
    }
    return out;
  }

  // Drive Flow's settings from the panel's model/aspect/count/duration.
  // Best effort per step; any failure is reported with a read-back of
  // what Flow actually has. Retried once (the first apply often hits a
  // half-rendered panel — Flow Auto v2.5.0).
  async function applyFlowSettingsOnce(opts) {
    var results = { model: step(false, "not attempted"), aspect: step(false, "not attempted"), count: null, duration: null };
    try {
      ensureAgentModeOff();
      var comp = findComposer();
      if (!comp) return { ok: false, results: results, reason: "no project composer on this page — open a project first" };
      var settingsBtn = findComposerFooterSettings(comp);
      if (!settingsBtn) return { ok: false, results: results, reason: "could not find Flow's Settings button in the composer footer" };
      var popover = await openSettingsPopover(settingsBtn);
      if (!popover) return { ok: false, results: results, reason: "Flow's settings did not open" };
      await selectMediaModeInPopover(popover, opts.wantImage);
      results.model = await selectModelInPopover(popover, opts.modelLabel);
      // The settings pane detaches/re-renders after a model switch —
      // re-find it before the next step.
      var pop2 = findSettingsPopover();
      if (pop2) {
        results.aspect = await selectAspectInPopover(pop2, opts.aspect);
        if (opts.wantImage) results.count = await selectCountInPopover(pop2, opts.count);
        if (opts.modelKey === "omni-flash") results.duration = await selectDurationInPopover(pop2, opts.duration);
      } else {
        results.aspect = step(false, "Flow's settings closed after the model switch — aspect could not be set this time");
      }
      await closeSettingsPopover(settingsBtn);
      var readback = readFlowSettingsState();
      return { ok: results.model.ok, results: results, readback: readback };
    } catch (e) {
      return { ok: false, results: results, reason: "could not set the model in Flow (" + (e && e.message ? e.message : e) + ")" };
    }
  }

  async function applyFlowSettingsImpl(opts) {
    var once = await applyFlowSettingsOnce(opts);
    if (once.ok) return once;
    await sleep(800);
    return await applyFlowSettingsOnce(opts);
  }

  var applyBusy = false;
  async function applyFlowSettings(opts) {
    if (applyBusy) return { ok: false, reason: "a settings apply is already running" };
    applyBusy = true;
    try { return await applyFlowSettingsImpl(opts); } finally { applyBusy = false; }
  }

  // ---------- orchestrator: fill prompt, then settings ----------

  function modelEntry(kind, modelKey) {
    var list = kind === "video" ? VIDEO_MODELS : IMAGE_MODELS;
    for (var i = 0; i < list.length; i++) {
      if (list[i].value === modelKey) return list[i];
    }
    return list[0];
  }

  async function fillLocal(opts) {
    var out = { ok: false, prompt: null, settings: null, readback: null, sendEnabled: false, error: "" };
    try {
      var comp = findComposer();
      if (!comp) {
        out.error = "Walang composer sa page na ito. Buksan mo muna ang isang project sa Flow, tapos pindutin mo ulit ang Fill.";
        return out;
      }
      if (!opts.prompt || !opts.prompt.trim()) {
        out.error = "Magsulat ka muna ng prompt.";
        return out;
      }
      var entry = modelEntry(opts.kind, opts.modelKey);
      var filled = await fillComposer(comp, opts.prompt.trim());
      out.prompt = filled;
      out.sendEnabled = filled.sendEnabled;
      if (!filled.ok) {
        out.error = "Hindi pumasok ang prompt sa box: " + (filled.reason || "unknown");
        return out;
      }
      var settingsRes = await applyFlowSettings({
        modelKey: entry.value,
        modelLabel: entry.menu,
        aspect: opts.aspect,
        count: opts.count,
        duration: opts.duration,
        wantImage: opts.kind === "image"
      });
      out.settings = settingsRes;
      out.readback = settingsRes.readback || readFlowSettingsState();
      out.ok = true;
      return out;
    } catch (e) {
      out.error = "Fill failed: " + (e && e.message ? e.message : e);
      return out;
    }
  }

  // ---------- storage (last-used prompt + settings only) ----------

  function storageGet(keys, callback) {
    try {
      var storage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
      if (storage && typeof storage.get === "function") {
        storage.get(keys, function (res) {
          try {
            if (chrome.runtime && chrome.runtime.lastError) { callback(null); return; }
          } catch (e) {}
          callback(res || {});
        });
        return;
      }
    } catch (e) {}
    callback(null);
  }

  function storageSet(obj, callback) {
    try {
      var storage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
      if (storage && typeof storage.set === "function") {
        storage.set(obj, function () {
          try { void chrome.runtime.lastError; } catch (e) {}
          if (callback) callback();
        });
        return;
      }
    } catch (e) {}
    if (callback) callback();
  }

  // ---------- panel shell (ported from Remote v1.1.1 content-panel.js) ----------

  var shadowRoot = null;
  var hostEl = null;
  var btnEl = null;
  var panelEl = null;
  var panelOpen = false;
  var suppressClickUntil = 0;
  var filling = false;

  function mk(tag, text, styles, attrs) {
    var el = document.createElement(tag);
    if (text != null) {
      try { el.textContent = text; } catch (e) {}
    }
    if (styles) {
      for (var k in styles) {
        try { el.style[k] = styles[k]; } catch (e) {}
      }
    }
    if (attrs) {
      for (var a in attrs) {
        try { el.setAttribute(a, attrs[a]); } catch (e) {}
      }
    }
    return el;
  }

  function el(id) {
    try { return shadowRoot ? shadowRoot.getElementById(id) : null; } catch (e) { return null; }
  }

  var INPUT_STYLE = {
    width: "100%", boxSizing: "border-box", fontSize: "16px", padding: "10px",
    border: "1px solid #aaa", borderRadius: "8px", fontFamily: "sans-serif",
    color: "#111", background: "#fff"
  };
  var BTN_STYLE = {
    fontSize: "15px", padding: "11px 14px", borderRadius: "8px",
    border: "1px solid #888", background: "#f2f2f2", color: "#111",
    cursor: "pointer", minHeight: "44px", fontFamily: "sans-serif"
  };
  var LABEL_STYLE = { display: "block", fontWeight: "bold", margin: "8px 0 3px", fontSize: "13px" };
  var HINT_STYLE = { fontSize: "12px", color: "#555", marginTop: "3px" };

  var MSG_STYLES = {
    "error": { background: "#fde2e2", color: "#8a1a1a", border: "1px solid #d33" },
    "warn": { background: "#fff3cd", color: "#6b4e00", border: "1px solid #e0a800" },
    "ok-msg": { background: "#dcf5dd", color: "#145a1a", border: "1px solid #188038" },
    "hint": { background: "transparent", color: "#555", border: "1px solid transparent" }
  };

  function showMsg(id, text, cls) {
    var node = el(id);
    if (!node) return;
    try {
      node.textContent = "";
      node.className = cls || "";
      var s = cls ? MSG_STYLES[cls] : null;
      node.style.background = s ? s.background : "transparent";
      node.style.color = s ? s.color : "#111";
      node.style.border = s ? s.border : "1px solid transparent";
      node.style.borderRadius = "8px";
      node.style.padding = text ? "8px" : "0";
      node.style.fontSize = "13px";
      node.style.margin = "8px 0";
      node.style.whiteSpace = "pre-wrap";
      if (text) node.textContent = text;
    } catch (e) {}
  }

  function selectedKind() {
    try {
      var checked = shadowRoot.querySelector('input[name="fl-kind"]:checked');
      return checked ? checked.value : "image";
    } catch (e) { return "image"; }
  }

  function fillSelect(id, options, selectedValue) {
    var node = el(id);
    if (!node) return;
    try {
      node.innerHTML = "";
      options.forEach(function (opt) {
        var value = typeof opt === "string" ? opt : opt.value;
        var label = typeof opt === "string" ? opt : (opt.label || opt.value);
        var o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        if (value === selectedValue) o.selected = true;
        node.appendChild(o);
      });
    } catch (e) {}
  }

  function modelOptionsForKind(kind) {
    return kind === "video" ? VIDEO_MODELS.slice() : IMAGE_MODELS.slice();
  }

  function defaultModelForKind(kind) {
    return kind === "video" ? "veo-lite" : "nano2";
  }

  function refreshModelLists() {
    var kind = selectedKind();
    fillSelect("fl-model", modelOptionsForKind(kind), defaultModelForKind(kind));
    fillSelect("fl-aspect", kind === "video" ? VIDEO_ASPECTS : IMAGE_ASPECTS, "9:16");
    fillSelect("fl-count", COUNTS.map(function (c) { return { value: c.slice(1), label: c }; }), "1");
    var modelKey = el("fl-model") ? el("fl-model").value : defaultModelForKind(kind);
    fillSelect("fl-duration",
      modelKey === "omni-flash"
        ? [{ value: "8", label: "8s" }, { value: "10", label: "10s (Omni Flash only)" }]
        : [{ value: "8", label: "8s" }],
      "8");
    var countRow = el("fl-count-row");
    var durationRow = el("fl-duration-row");
    try {
      if (countRow) countRow.style.display = kind === "video" ? "none" : "";
      if (durationRow) durationRow.style.display = kind === "video" ? "" : "none";
    } catch (e) {}
  }

  function setPanelOpen(open) {
    panelOpen = open;
    try {
      if (panelEl) panelEl.style.display = open ? "block" : "none";
      if (btnEl) btnEl.textContent = open ? "⚡ Flow Local ✕" : "⚡ Flow Local";
    } catch (e) {}
    storageSet({ flowLocalPanelOpen: open }, function () {});
  }

  function togglePanel() {
    try {
      if (Date.now() < suppressClickUntil) return; // was a drag, not a tap
      setPanelOpen(!panelOpen);
    } catch (e) {}
  }

  function wireDrag(node) {
    var drag = null;
    var moved = 0;
    function begin(x, y) {
      var r = 12, b = 12;
      try {
        r = parseFloat(node.style.right) || 12;
        b = parseFloat(node.style.bottom) || 12;
      } catch (e) {}
      drag = { x: x, y: y, r: r, b: b };
      moved = 0;
    }
    function move(x, y) {
      if (!drag) return false;
      try {
        var dx = x - drag.x;
        var dy = y - drag.y;
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
        node.style.right = Math.max(0, drag.r - dx) + "px";
        node.style.bottom = Math.max(0, drag.b - dy) + "px";
      } catch (e) {}
      return true;
    }
    function end() {
      if (drag && moved > 8) suppressClickUntil = Date.now() + 100;
      drag = null;
    }
    try {
      node.addEventListener("pointerdown", function (ev) {
        try {
          begin(ev.clientX, ev.clientY);
          if (node.setPointerCapture) { try { node.setPointerCapture(ev.pointerId); } catch (e) {} }
        } catch (e) {}
      });
      node.addEventListener("pointermove", function (ev) {
        try { if (move(ev.clientX, ev.clientY)) ev.preventDefault(); } catch (e) {}
      });
      node.addEventListener("pointerup", function () { try { end(); } catch (e) {} });
      node.addEventListener("pointercancel", function () { try { end(); } catch (e) {} });
      node.addEventListener("touchstart", function (ev) {
        try {
          var t = ev.touches && ev.touches[0];
          if (t) begin(t.clientX, t.clientY);
        } catch (e) {}
      }, { passive: false });
      node.addEventListener("touchmove", function (ev) {
        try {
          var t = ev.touches && ev.touches[0];
          if (t && move(t.clientX, t.clientY)) ev.preventDefault();
        } catch (e) {}
      }, { passive: false });
      node.addEventListener("touchend", function () { try { end(); } catch (e) {} });
      node.addEventListener("touchcancel", function () { try { end(); } catch (e) {} });
    } catch (e) {}
  }

  function buildPanel() {
    // Host on documentElement so the panel survives the page replacing
    // <body>. all: initial isolates it from Flow's CSS.
    hostEl = mk("div", null, { all: "initial" });
    try { hostEl.setAttribute("id", "fl-host"); } catch (e) {}
    try { hostEl.id = "fl-host"; } catch (e) {}
    var host = null;
    try {
      host = hostEl.attachShadow({ mode: "open" });
    } catch (e) {
      host = null;
    }
    if (!host) return false;
    shadowRoot = host;

    btnEl = mk("button", "⚡ Flow Local", {
      position: "fixed", right: "12px", bottom: "12px", zIndex: "2147483647",
      padding: "10px 14px", borderRadius: "20px", border: "1px solid #888",
      background: "#111", color: "#fff", fontSize: "14px", cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)", fontFamily: "sans-serif",
      touchAction: "none"
    }, { id: "fl-btn", type: "button" });
    btnEl.addEventListener("click", togglePanel);
    wireDrag(btnEl);
    shadowRoot.appendChild(btnEl);

    panelEl = mk("div", null, {
      position: "fixed", right: "12px", bottom: "60px",
      width: "calc(100vw - 20px)", maxWidth: "520px", maxHeight: "80vh",
      overflowY: "auto", zIndex: "2147483647", background: "#fff", color: "#111",
      border: "1px solid #999", borderRadius: "12px", padding: "12px",
      fontFamily: "sans-serif", fontSize: "14px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.3)", display: "none"
    }, { id: "fl-panel" });

    // Stop Enter/Escape from reaching Flow's editor underneath.
    panelEl.addEventListener("keydown", function (ev) {
      try {
        if (ev.key === "Enter" || ev.key === "Escape") ev.stopPropagation();
      } catch (e) {}
    });

    var head = mk("div", null, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" });
    head.appendChild(mk("strong", "Flow Local", { flex: "1", fontSize: "17px" }));
    var closeBtn = mk("button", "✕", {
      padding: "4px 10px", cursor: "pointer", fontSize: "15px",
      border: "1px solid #888", borderRadius: "8px", background: "#f2f2f2", color: "#111",
      fontFamily: "sans-serif", minHeight: "36px"
    }, { type: "button" });
    closeBtn.addEventListener("click", function () { setPanelOpen(false); });
    head.appendChild(closeBtn);
    panelEl.appendChild(head);

    panelEl.appendChild(mk("div",
      "Fill-only ito: ilalagay nito ang prompt at settings mo sa mismong Flow page. Pagkatapos, IKAW ang pipindot ng Send sa Flow — hindi ito kayang pindutin ng extension.",
      { background: "#fff3cd", border: "1px solid #e0a800", borderRadius: "8px", padding: "8px", fontSize: "13px", margin: "8px 0" }));

    var kindRow = mk("div", null, { display: "flex", gap: "16px", margin: "6px 0" });
    var labImg = mk("label", null, { display: "inline", fontWeight: "normal", margin: "0" });
    var radioImg = mk("input", null, {});
    radioImg.type = "radio";
    radioImg.name = "fl-kind";
    radioImg.value = "image";
    radioImg.checked = true;
    labImg.appendChild(radioImg);
    labImg.appendChild(document.createTextNode(" Image"));
    var labVid = mk("label", null, { display: "inline", fontWeight: "normal", margin: "0" });
    var radioVid = mk("input", null, {});
    radioVid.type = "radio";
    radioVid.name = "fl-kind";
    radioVid.value = "video";
    labVid.appendChild(radioVid);
    labVid.appendChild(document.createTextNode(" Video"));
    kindRow.appendChild(labImg);
    kindRow.appendChild(labVid);
    panelEl.appendChild(kindRow);

    panelEl.appendChild(mk("label", "Prompt", LABEL_STYLE, { for: "fl-prompt" }));
    var promptEl = mk("textarea", null, INPUT_STYLE, { id: "fl-prompt", placeholder: "Describe what to generate…" });
    promptEl.style.minHeight = "64px";
    panelEl.appendChild(promptEl);
    panelEl.appendChild(mk("label", "Model", LABEL_STYLE, { for: "fl-model" }));
    panelEl.appendChild(mk("select", null, INPUT_STYLE, { id: "fl-model" }));
    panelEl.appendChild(mk("label", "Aspect", LABEL_STYLE, { for: "fl-aspect" }));
    panelEl.appendChild(mk("select", null, INPUT_STYLE, { id: "fl-aspect" }));
    var countRow = mk("div", null, {}, { id: "fl-count-row" });
    countRow.appendChild(mk("label", "Count (image only)", LABEL_STYLE, { for: "fl-count" }));
    countRow.appendChild(mk("select", null, INPUT_STYLE, { id: "fl-count" }));
    panelEl.appendChild(countRow);
    var durRow = mk("div", null, { display: "none" }, { id: "fl-duration-row" });
    durRow.appendChild(mk("label", "Duration (video only)", LABEL_STYLE, { for: "fl-duration" }));
    durRow.appendChild(mk("select", null, INPUT_STYLE, { id: "fl-duration" }));
    panelEl.appendChild(durRow);

    var fillRow = mk("div", null, { display: "flex", gap: "8px", margin: "8px 0" });
    var fillBtn = mk("button", "Fill sa Flow", BTN_STYLE, { id: "fl-fill", type: "button" });
    fillBtn.style.background = "#1a73e8";
    fillBtn.style.color = "#fff";
    fillBtn.style.borderColor = "#1a73e8";
    fillBtn.style.width = "100%";
    fillBtn.style.fontWeight = "bold";
    fillRow.appendChild(fillBtn);
    panelEl.appendChild(fillRow);
    panelEl.appendChild(mk("div", "", {}, { id: "fl-msg" }));
    panelEl.appendChild(mk("div", "", HINT_STYLE, { id: "fl-readback" }));

    panelEl.appendChild(mk("footer",
      "Walang server, walang token, walang kinokontak na kahit ano — lahat dito lang sa page nangyayari. Pagkatapos ng Fill, ikaw ang pipindot ng Send sa Flow.",
      { marginTop: "16px", borderTop: "1px solid #ddd", paddingTop: "8px", fontSize: "12px", color: "#555" }));

    shadowRoot.appendChild(panelEl);

    try {
      document.documentElement.appendChild(hostEl);
    } catch (e) {
      return false;
    }
    return true;
  }

  function readPanelValues() {
    var kind = selectedKind();
    var prompt = el("fl-prompt") ? el("fl-prompt").value : "";
    var modelKey = el("fl-model") ? el("fl-model").value : defaultModelForKind(kind);
    var aspect = el("fl-aspect") ? el("fl-aspect").value : "9:16";
    var count = 1;
    try { count = Math.max(1, Math.min(4, parseInt(el("fl-count").value, 10) || 1)); } catch (e) {}
    var duration = 8;
    try { duration = parseInt(el("fl-duration").value, 10) || 8; } catch (e) {}
    return { kind: kind, prompt: prompt, modelKey: modelKey, aspect: aspect, count: count, duration: duration };
  }

  function formatFillResult(res) {
    var lines = [];
    if (res.prompt && res.prompt.ok) {
      lines.push("✓ Prompt nasa box na (" + res.prompt.method + ").");
    } else if (res.prompt) {
      lines.push("✗ Prompt: " + (res.prompt.reason || "hindi pumasok"));
    }
    if (res.settings && res.settings.results) {
      var r = res.settings.results;
      lines.push((r.model.ok ? "✓" : "✗") + " Model: " + (r.model.note || ""));
      lines.push((r.aspect.ok ? "✓" : "✗") + " Aspect: " + (r.aspect.note || ""));
      if (r.count) lines.push((r.count.ok ? "✓" : "✗") + " Count: " + (r.count.note || ""));
      if (r.duration) lines.push((r.duration.ok ? "✓" : "✗") + " Duration: " + (r.duration.note || ""));
      if (res.settings.reason) lines.push("! " + res.settings.reason);
    }
    if (res.readback && res.readback.summary) {
      lines.push("Flow ngayon: " + res.readback.summary);
    }
    if (res.ok && res.sendEnabled) {
      lines.push("Handa na — ikaw na ang pipindot ng Send sa Flow.");
    } else if (res.ok && !res.sendEnabled) {
      lines.push("Nasa box na ang prompt, pero naka-disable pa rin ang Send ng Flow — tingnan mo muna ang box bago mag-tap.");
    }
    return lines.join("\n");
  }

  async function onFillTap() {
    if (filling) return;
    var btn = el("fl-fill");
    var vals = readPanelValues();
    if (!vals.prompt.trim()) {
      showMsg("fl-msg", "Magsulat ka muna ng prompt.", "error");
      return;
    }
    filling = true;
    if (btn) { try { btn.disabled = true; btn.textContent = "Filling…"; } catch (e) {} }
    showMsg("fl-msg", "", "");
    try {
      storageSet({ flowLocalLast: vals }, function () {});
      var res = await fillLocal(vals);
      if (res.ok) {
        showMsg("fl-msg", formatFillResult(res), "ok-msg");
        try {
          var rb = res.readback;
          var bits = [];
          if (rb && rb.model) bits.push("model: " + rb.model);
          if (rb && rb.aspect) bits.push("aspect: " + rb.aspect);
          if (rb && rb.outputs) bits.push("outputs: " + rb.outputs);
          var rbEl = el("fl-readback");
          if (rbEl) rbEl.textContent = bits.length ? "Flow ngayon — " + bits.join(" · ") : "";
        } catch (e) {}
      } else {
        showMsg("fl-msg", res.error || "Fill failed.", "error");
      }
    } catch (e) {
      showMsg("fl-msg", "Fill failed: " + (e && e.message ? e.message : e), "error");
    } finally {
      filling = false;
      if (btn) { try { btn.disabled = false; btn.textContent = "Fill sa Flow"; } catch (e) {} }
    }
  }

  function init() {
    if (!buildPanel()) return;

    try {
      shadowRoot.querySelectorAll('input[name="fl-kind"]').forEach(function (r) {
        r.addEventListener("change", refreshModelLists);
      });
      var modelEl = el("fl-model");
      if (modelEl) {
        modelEl.addEventListener("change", function () {
          var kind = selectedKind();
          if (kind === "video") {
            var key = modelEl.value;
            fillSelect("fl-duration",
              key === "omni-flash"
                ? [{ value: "8", label: "8s" }, { value: "10", label: "10s (Omni Flash only)" }]
                : [{ value: "8", label: "8s" }],
              "8");
          }
        });
      }
      var fillBtn = el("fl-fill");
      if (fillBtn) fillBtn.addEventListener("click", onFillTap);
    } catch (e) {}

    refreshModelLists();

    // Restore last-used values (prompt + settings only — no token, no URL).
    storageGet({ flowLocalLast: null, flowLocalPanelOpen: false }, function (res) {
      try {
        var last = res && res.flowLocalLast ? res.flowLocalLast : null;
        if (last) {
          try {
            if (last.kind === "video") {
              var radios = shadowRoot.querySelectorAll('input[name="fl-kind"]');
              radios.forEach(function (r) { r.checked = (r.value === "video"); });
              refreshModelLists();
            }
            if (el("fl-prompt") && typeof last.prompt === "string") el("fl-prompt").value = last.prompt;
            if (el("fl-model") && last.modelKey) el("fl-model").value = last.modelKey;
            if (el("fl-aspect") && last.aspect) el("fl-aspect").value = last.aspect;
            if (el("fl-count") && last.count) el("fl-count").value = String(last.count);
            if (el("fl-duration") && last.duration) el("fl-duration").value = String(last.duration);
          } catch (e) {}
        }
        if (res && res.flowLocalPanelOpen) setPanelOpen(true);
      } catch (e) {}
    });

    try {
      window.addEventListener("unload", function () {});
    } catch (e) {}
  }

  function initPanel(doc) {
    try {
      if (!doc || !doc.documentElement) return;
      init();
    } catch (e) {}
  }

  // Browser entry: the content script runs at document_idle, so the DOM
  // is ready; still tolerate document_start.
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () { initPanel(document); });
      } else {
        initPanel(document);
      }
    }
  } catch (e) {
    try { initPanel(typeof document !== "undefined" ? document : null); } catch (e2) {}
  }

  // Node (test) export; browser global otherwise.
  try {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = {
        initPanel: initPanel,
        internals: {
          fillLocal: fillLocal,
          fillComposer: fillComposer,
          findComposer: findComposer,
          findSendButton: findSendButton,
          isFlowSendEnabled: isFlowSendEnabled,
          readFlowSettingsState: readFlowSettingsState,
          applyFlowSettings: applyFlowSettings,
          setPanelOpen: setPanelOpen,
          getShadowRoot: function () { return shadowRoot; },
          isPanelOpen: function () { return panelOpen; },
          getFilling: function () { return filling; }
        }
      };
    }
  } catch (e) {}
})();
