// Flow Remote — background.js (v1.1.0)
// Stateless fetch proxy + health beacon. Orion iOS prefers
// `background.scripts` over `background.service_worker` when both are
// declared (see manifest.json); this file must therefore also work as a
// plain background page script.
//
// Its jobs:
//   1. Write a boot health beacon to chrome.storage.local (Inkpour
//      pattern) so the in-page panel can show RUNNING / NOT RESPONDING /
//      NEVER STARTED even when this background is suspended.
//   2. Answer {type:"api"} messages from the content panel: one message
//      in, one fetch to the user's server (via api.js), one reply back.
//      No state is kept here — the panel holds settings and job state in
//      chrome.storage.local and its own memory.
//   3. Answer {type:"getSettings"} for the desktop popup (kept as a
//      fallback UI) and {type:"ping"} for the panel's health check.
//
// No webRequest anywhere (unreliable on Orion iOS). No fetch to Flow.
// No chrome.storage.session (missing on Orion iOS — using it can kill
// the background). No timers, no polling, no long-lived connections:
// WebKit kills background contexts quickly, so this file must do its
// work synchronously-shaped and exit.
//
// api.js is loaded BEFORE this file via background.scripts on
// background-page browsers. On service-worker browsers (Chrome) only
// `background.service_worker` runs, so api.js is pulled in here with a
// GUARDED importScripts() — unguarded importScripts() throws in a
// background page and aborts the whole file before any listener
// registers (the Inkpour root cause).

(function () {
  "use strict";

  var VERSION = "1.1.0";

  // Load api.js when running as a service worker (importScripts exists
  // only in WorkerGlobalScope; it is absent in a background page, where
  // background.scripts already loaded api.js).
  try {
    if (typeof importScripts === "function" &&
        (typeof FlowRemoteApi === "undefined")) {
      importScripts("api.js");
    }
  } catch (e) {}

  var api = null;
  try {
    api = (typeof FlowRemoteApi !== "undefined") ? FlowRemoteApi : null;
  } catch (e) { api = null; }
  if (!api && typeof require === "function") {
    try { api = require("./api.js"); } catch (e) { api = null; }
  }

  var settingsCache = { serverUrl: "", token: "" };

  function safeGetSettings(callback) {
    try {
      var storage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
      if (!storage || typeof storage.get !== "function") {
        callback(settingsCache);
        return;
      }
      storage.get({ serverUrl: "", token: "" }, function (res) {
        try {
          if (chrome.runtime && chrome.runtime.lastError) {
            callback(settingsCache);
            return;
          }
          if (res) {
            if (typeof res.serverUrl === "string") settingsCache.serverUrl = res.serverUrl;
            if (typeof res.token === "string") settingsCache.token = res.token;
          }
        } catch (e) {}
        callback(settingsCache);
      });
    } catch (e) {
      try { callback(settingsCache); } catch (e2) {}
    }
  }

  // Boot health beacon: proves this background started at least once.
  // The panel reads it from storage and combines it with a live ping.
  function writeBeacon() {
    try {
      var storage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
      if (storage && typeof storage.set === "function") {
        var beacon = { version: VERSION, startedAt: "", alive: true };
        try { beacon.startedAt = new Date().toISOString(); } catch (e) {}
        storage.set({ flowRemoteBeacon: beacon }, function () {
          try { void chrome.runtime.lastError; } catch (e) {}
        });
      }
    } catch (e) {}
  }

  // Restore the settings cache on startup. Never throws if storage is absent.
  try {
    safeGetSettings(function () {});
  } catch (e) {}

  try { writeBeacon(); } catch (e) {}

  // Message handler. Every branch is guarded; a bad message must never
  // take the listener (or the file) down.
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage &&
        typeof chrome.runtime.onMessage.addListener === "function") {
      chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
        try {
          if (!msg || typeof msg.type !== "string") return false;

          if (msg.type === "getSettings") {
            safeGetSettings(function (settings) {
              try { sendResponse({ ok: true, settings: settings }); } catch (e) {}
            });
            return true; // async response
          }

          if (msg.type === "ping") {
            try { sendResponse({ ok: true, alive: true, version: VERSION }); } catch (e) {}
            return false; // sync response
          }

          if (msg.type === "api") {
            if (!api) {
              try {
                sendResponse({ ok: false, code: "server",
                  message: "Background API client unavailable — reload the page." });
              } catch (e) {}
              return false;
            }
            var s = (msg && msg.settings) || { serverUrl: "", token: "" };
            var method = typeof msg.method === "string" ? msg.method : "GET";
            var path = typeof msg.path === "string" ? msg.path : "/";
            var body = msg.body === undefined ? null : msg.body;
            api.request(s, method, path, body)
              .then(function (data) {
                try { sendResponse({ ok: true, data: data }); } catch (e) {}
              })
              .catch(function (err) {
                try {
                  sendResponse({
                    ok: false,
                    code: (err && err.code) || "server",
                    message: (err && err.message) || "Server error."
                  });
                } catch (e) {}
              });
            return true; // async response
          }
        } catch (e) {}
        return false;
      });
    }
  } catch (e) {
    // chrome.runtime missing: nothing else can be done from the background.
  }
})();
