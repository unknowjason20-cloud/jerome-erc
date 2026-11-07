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
// Single-file by design (v1.1.1): the fetch client is inlined below,
// so this file needs no other script and no importScripts() at all.

(function () {
  "use strict";

  var VERSION = "1.1.1";

  // Self-contained in v1.1.1: the fetch client below is inlined from
  // api.js so the background is a SINGLE file — no api.js load, no
  // importScripts at all (its unguarded form aborts the whole file
  // on Orion). The popup still loads api.js itself on desktop.

  var TIMEOUT_MS = 15000;

  function normalizeBaseUrl(url) {
    if (typeof url !== "string") return "";
    return url.trim().replace(/\/+$/, "");
  }

  function apiError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function serverMessage(body) {
    try {
      if (body && typeof body === "object") {
        if (typeof body.error === "string" && body.error) return body.error;
        if (typeof body.message === "string" && body.message) return body.message;
        if (typeof body.detail === "string" && body.detail) return body.detail;
      }
    } catch (e) {}
    return "";
  }

  function errorForStatus(status, body) {
    var msg = serverMessage(body);
    if (status === 401) {
      return apiError("wrong_token",
        "Wrong or expired pairing token. Re-copy the token from the " +
        "Codespace terminal and paste it in Settings.");
    }
    if (status === 503) {
      return apiError("stopped",
        "Server stopped (unusual-activity stop). Stop sending jobs and " +
        "restart the server in the Codespace.");
    }
    if (status === 404) {
      return apiError("not_found",
        msg || "Not found on the server (unknown profile or job).");
    }
    if (status === 400) {
      return apiError("validation", msg || "The server rejected the job (check the form).");
    }
    return apiError("server", msg || ("Server error (HTTP " + status + ")."));
  }

  function request(settings, method, path, body, fetchFn) {
    var baseUrl = normalizeBaseUrl(settings && settings.serverUrl);
    var token = settings && settings.token ? String(settings.token) : "";
    if (!baseUrl) {
      return Promise.reject(apiError("not_configured",
        "Not configured yet — enter the server URL and pairing token in Settings."));
    }
    if (!token) {
      return Promise.reject(apiError("not_configured",
        "No pairing token saved — paste it in Settings first."));
    }
    var doFetch = fetchFn || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) {
      return Promise.reject(apiError("network", "fetch is not available in this browser."));
    }

    var controller = null;
    var signal = undefined;
    try {
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        signal = controller.signal;
      }
    } catch (e) { controller = null; }
    var timer = null;
    if (controller) {
      timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, TIMEOUT_MS);
    }

    var headers = { "X-Flow-Token": token };
    var opts = { method: method, headers: headers };
    if (signal) opts.signal = signal;
    if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    return Promise.resolve()
      .then(function () { return doFetch(baseUrl + path, opts); })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        var status = res && typeof res.status === "number" ? res.status : 0;
        return Promise.resolve()
          .then(function () {
            if (res && typeof res.json === "function") return res.json();
            return null;
          })
          .catch(function () { return null; })
          .then(function (data) {
            if (status >= 200 && status < 300) return data;
            throw errorForStatus(status, data);
          });
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        if (err && err.code) throw err; // already a mapped apiError
        var name = err && err.name ? String(err.name) : "";
        var msg = err && err.message ? String(err.message) : "";
        if (name === "AbortError" || /abort/i.test(msg)) {
          throw apiError("timeout",
            "Server did not answer in " + (TIMEOUT_MS / 1000) + "s — is the Codespace still running?");
        }
        throw apiError("network",
          "Cannot reach the server. Check the URL and that the Codespace is running. (" + (msg || "network error") + ")");
      });
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
            var s = (msg && msg.settings) || { serverUrl: "", token: "" };
            var method = typeof msg.method === "string" ? msg.method : "GET";
            var path = typeof msg.path === "string" ? msg.path : "/";
            var body = msg.body === undefined ? null : msg.body;
            request(s, method, path, body)
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
