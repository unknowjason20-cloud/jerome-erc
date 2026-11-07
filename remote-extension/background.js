// Flow Remote — background.js
// Minimal and fully guarded. Orion iOS prefers `background.scripts` over
// `background.service_worker` when both are declared (see manifest.json);
// this file must therefore also work as a plain background page script.
//
// Its only job: keep a tiny settings cache in chrome.storage.local and
// answer "getSettings" messages from the popup. It keeps NO job state in
// memory that the popup needs — the popup reads storage and talks to the
// server directly, so it works even when this background is suspended.
// No webRequest anywhere (unreliable on Orion iOS). No fetch to Flow.

(function () {
  "use strict";

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

  // Restore the settings cache on startup. Never throws if storage is absent.
  try {
    safeGetSettings(function () {});
  } catch (e) {}

  // Message handler the popup MAY use. The popup has a direct-storage
  // fallback if this background never answers (suspended / unavailable).
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
        } catch (e) {}
        return false;
      });
    }
  } catch (e) {
    // chrome.runtime missing: nothing else can be done from the background.
  }
})();
