// Flow Remote — popup.js
// Popup reads settings from chrome.storage.local and talks to the server
// directly (fetch) — it does NOT depend on the background for API calls,
// because on Orion iOS the background can be suspended at any time.
// Every chrome.* call is guarded (feature-detect + try/catch); a missing
// API must never abort this file. No webRequest anywhere.
//
// Guarded for node: the DOM init only runs when `document` exists, so the
// test can load api.js alone. Popup logic that the test needs (model lists,
// job HTML) lives in api.js, not here.

(function () {
  "use strict";

  var api = null;
  try {
    api = (typeof FlowRemoteApi !== "undefined") ? FlowRemoteApi : null;
  } catch (e) { api = null; }
  if (!api && typeof require === "function") {
    try { api = require("./api.js"); } catch (e) { api = null; }
  }
  if (!api) return; // api.js failed to load; nothing usable can be done.

  // ---- storage helpers (guarded, storage-first) ----

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

  // Settings via background message (optional) with direct-storage fallback.
  function loadSettings(callback) {
    var done = false;
    var finish = function (s) {
      if (done) return;
      done = true;
      callback({ serverUrl: (s && s.serverUrl) || "", token: (s && s.token) || "" });
    };
    try {
      if (typeof chrome !== "undefined" && chrome.runtime &&
          typeof chrome.runtime.sendMessage === "function") {
        var answered = false;
        chrome.runtime.sendMessage({ type: "getSettings" }, function (res) {
          answered = true;
          try { void chrome.runtime.lastError; } catch (e) {}
          if (res && res.settings) finish(res.settings);
          else storageGet({ serverUrl: "", token: "" }, finish);
        });
        // If the background never answers (suspended), fall back after 1s.
        setTimeout(function () { if (!answered) storageGet({ serverUrl: "", token: "" }, finish); }, 1000);
        return;
      }
    } catch (e) {}
    storageGet({ serverUrl: "", token: "" }, finish);
  }

  // ---- DOM init (browser only) ----
  if (typeof document === "undefined" || !document.getElementById) return;

  var settings = { serverUrl: "", token: "" };
  var accounts = [];
  var pollTimer = null;

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  function setText(id, text) {
    var el = $(id);
    if (el) { try { el.textContent = text; } catch (e) {} }
  }

  function setHtml(id, html) {
    var el = $(id);
    if (el) { try { el.innerHTML = html; } catch (e) {} }
  }

  function showMsg(id, text, cls) {
    var el = $(id);
    if (!el) return;
    try {
      el.textContent = "";
      el.className = cls || "";
      if (text) el.textContent = text;
    } catch (e) {}
  }

  function client() { return api.createClient(settings); }

  function selectedKind() {
    try {
      var checked = document.querySelector('input[name="kind"]:checked');
      return checked ? checked.value : "image";
    } catch (e) { return "image"; }
  }

  function fillSelect(id, options, selectedValue) {
    var el = $(id);
    if (!el) return;
    try {
      el.innerHTML = "";
      options.forEach(function (opt) {
        var value = typeof opt === "string" ? opt : opt.value;
        var label = typeof opt === "string" ? opt : (opt.label || opt.value);
        var o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        if (value === selectedValue) o.selected = true;
        el.appendChild(o);
      });
    } catch (e) {}
  }

  function refreshModelLists() {
    var kind = selectedKind();
    fillSelect("model", api.modelOptionsForKind(kind), api.defaultModelForKind(kind));
    fillSelect("aspect", api.aspectOptionsForKind(kind), "9:16");
    fillSelect("duration", api.durationOptionsForModel($("model") ? $("model").value : api.defaultModelForKind(kind)), "8");
    var countRow = $("count-row");
    var durationRow = $("duration-row");
    try {
      if (countRow) countRow.style.display = kind === "video" ? "none" : "";
      if (durationRow) durationRow.style.display = kind === "video" ? "" : "none";
    } catch (e) {}
  }

  function setStatus(state, detail) {
    var el = $("status");
    if (!el) return;
    var labels = {
      "connected": "Connected",
      "stopped": "Stopped (unusual activity)",
      "offline": "Offline / wrong token",
      "not-configured": "Not configured"
    };
    try {
      el.className = state;
      el.textContent = labels[state] || state;
      setText("status-detail", detail || "");
    } catch (e) {}
  }

  function refreshHealth() {
    if (!settings.serverUrl || !settings.token) {
      setStatus("not-configured", "Enter the server URL and pairing token in Settings.");
      return Promise.resolve(null);
    }
    return client().getHealth().then(function (h) {
      if (h && h.stopped) {
        setStatus("stopped", "The server stopped itself after Flow flagged unusual activity. Stop sending jobs and restart the server in the Codespace.");
      } else {
        var q = h && h.queue ? h.queue : {};
        setStatus("connected",
          "Server OK" + (h && h.version ? " · v" + h.version : "") +
          (h && h.gflow ? " · gflow ready" : "") +
          " · running " + (q.running || 0) + ", queued " + (q.queued || 0) + ".");
      }
      return h;
    }).catch(function (err) {
      if (err && err.code === "stopped") {
        setStatus("stopped", err.message);
      } else if (err && err.code === "wrong_token") {
        setStatus("offline", err.message);
      } else {
        setStatus("offline", err ? err.message : "Cannot reach the server.");
      }
      return null;
    });
  }

  function refreshAccounts() {
    var select = $("account");
    var warn = $("account-warn");
    if (!settings.serverUrl || !settings.token) {
      if (select) { try { select.innerHTML = ""; } catch (e) {} }
      showMsg("account-warn", "Configure the server first (Settings above).", "hint");
      return Promise.resolve([]);
    }
    return client().getAccounts().then(function (list) {
      accounts = Array.isArray(list) ? list : [];
      try {
        if (select) {
          select.innerHTML = "";
          accounts.forEach(function (a) {
            var o = document.createElement("option");
            o.value = a.name || "";
            var label = a.google_account || a.name || "(unnamed)";
            label += a.session === "present" ? " — session OK" : " — session " + (a.session || "unknown");
            o.textContent = label;
            if (a.is_default) o.selected = true;
            select.appendChild(o);
          });
        }
      } catch (e) {}
      updateAccountWarn();
      return accounts;
    }).catch(function (err) {
      showMsg("account-warn", err ? err.message : "Could not load accounts.", "error");
      return [];
    });
  }

  function selectedAccount() {
    try {
      var select = $("account");
      if (!select || !select.value) return null;
      for (var i = 0; i < accounts.length; i++) {
        if (accounts[i].name === select.value) return accounts[i];
      }
      return { name: select.value, session: "unknown" };
    } catch (e) { return null; }
  }

  function updateAccountWarn() {
    var a = selectedAccount();
    if (!a) { showMsg("account-warn", "", ""); return; }
    if (a.session === "missing") {
      showMsg("account-warn",
        "⚠️ This account has no saved session. Run this in the Codespace terminal first:\n" +
        "gflow auth login --profile " + (a.name || "") +
        "\nThe extension cannot log anyone in.", "warn");
    } else if (a.session === "unknown") {
      showMsg("account-warn", "Session state unknown for this account.", "hint");
    } else {
      showMsg("account-warn", "", "");
    }
  }

  function copyText(text, btn) {
    var done = function () { if (btn) { try { btn.textContent = "Copied!"; } catch (e) {} } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
        return;
      }
    } catch (e) {}
    fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      ta.remove();
      if (done) done();
    } catch (e) {}
  }

  function wireMediaButtons(container) {
    if (!container) return;
    try {
      var copies = container.querySelectorAll(".copy-btn");
      copies.forEach(function (btn) {
        btn.addEventListener("click", function () { copyText(btn.getAttribute("data-url") || "", btn); });
      });
      var dls = container.querySelectorAll(".dl-btn");
      dls.forEach(function (btn) {
        btn.addEventListener("click", function () {
          // Best-effort only: chrome.downloads is unknown on Orion iOS.
          // An <a download> click may work; if not, use Open / Copy URL.
          try {
            var url = btn.getAttribute("data-url") || "";
            var a = document.createElement("a");
            a.href = url;
            a.download = url.split("/").pop() || "flow-media";
            a.target = "_blank";
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
          } catch (e) {}
        });
      });
    } catch (e) {}
  }

  function refreshJobs() {
    var list = $("jobs-list");
    if (!settings.serverUrl || !settings.token) {
      setHtml("jobs-list", '<div class="empty">Configure the server first (Settings above).</div>');
      return Promise.resolve([]);
    }
    return client().listJobs().then(function (jobs) {
      setHtml("jobs-list", api.jobListHtml(jobs));
      wireMediaButtons(list);
      return jobs;
    }).catch(function (err) {
      setHtml("jobs-list", "");
      showMsg("jobs-list", "", "");
      var el = $("jobs-list");
      if (el) {
        try {
          var div = document.createElement("div");
          div.className = "error";
          div.textContent = err ? err.message : "Could not load jobs.";
          el.appendChild(div);
        } catch (e) {}
      }
      return [];
    });
  }

  function sendJob() {
    var btn = $("send-job");
    var promptEl = $("prompt");
    var prompt = promptEl ? promptEl.value.trim() : "";
    if (!prompt) {
      showMsg("job-msg", "Type a prompt first.", "error");
      return;
    }
    var account = selectedAccount();
    if (!account) {
      showMsg("job-msg", "Pick an account first (Refresh accounts).", "error");
      return;
    }
    if (account.session === "missing") {
      showMsg("job-msg",
        "That account has no saved session. Run `gflow auth login --profile " +
        (account.name || "") + "` in the Codespace terminal first.", "error");
      return;
    }
    var kind = selectedKind();
    var job = {
      profile: account.name,
      kind: kind,
      prompt: prompt,
      model: $("model") ? $("model").value : api.defaultModelForKind(kind),
      aspect: $("aspect") ? $("aspect").value : "9:16"
    };
    if (kind === "image") {
      var count = 1;
      try { count = Math.max(1, Math.min(4, parseInt($("count").value, 10) || 1)); } catch (e) {}
      job.count = count;
    } else {
      var dur = 8;
      try { dur = parseInt($("duration").value, 10) || 8; } catch (e) {}
      job.duration = dur;
    }
    // NOTE: this is the ONLY place a job is ever POSTed — from an explicit
    // tap on Send job. Blocked jobs are never re-sent: there is no retry
    // loop, no auto-resubmit, and no code path that POSTs for a blocked job.
    showMsg("job-msg", "", "");
    if (btn) { try { btn.disabled = true; btn.textContent = "Sending…"; } catch (e) {} }
    client().createJob(job).then(function (res) {
      showMsg("job-msg",
        "Job queued — ID: " + (res && res.id ? res.id : "(no id returned)") +
        " (" + (res && res.status ? res.status : "queued") + ").", "ok-msg");
      try { if (promptEl) promptEl.value = ""; } catch (e) {}
      refreshJobs();
    }).catch(function (err) {
      showMsg("job-msg", err ? err.message : "Could not send the job.", "error");
    }).finally(function () {
      if (btn) { try { btn.disabled = false; btn.textContent = "Send job"; } catch (e) {} }
    });
  }

  function init() {
    // Kind / model / duration wiring.
    try {
      document.querySelectorAll('input[name="kind"]').forEach(function (r) {
        r.addEventListener("change", refreshModelLists);
      });
      var modelEl = $("model");
      if (modelEl) {
        modelEl.addEventListener("change", function () {
          var kind = selectedKind();
          if (kind === "video") {
            fillSelect("duration", api.durationOptionsForModel(modelEl.value), "8");
          }
        });
      }
      var accountEl = $("account");
      if (accountEl) accountEl.addEventListener("change", updateAccountWarn);
    } catch (e) {}

    refreshModelLists();

    try {
      var saveBtn = $("save-settings");
      if (saveBtn) saveBtn.addEventListener("click", function () {
        var url = $("server-url") ? $("server-url").value : "";
        var token = $("token") ? $("token").value : "";
        settings.serverUrl = api.normalizeBaseUrl(url);
        settings.token = token.trim();
        storageSet({ serverUrl: settings.serverUrl, token: settings.token }, function () {
          showMsg("settings-msg", "Saved.", "ok-msg");
          refreshHealth();
          refreshAccounts();
          refreshJobs();
        });
      });
      var testBtn = $("test-connection");
      if (testBtn) testBtn.addEventListener("click", function () {
        var url = $("server-url") ? $("server-url").value : "";
        var token = $("token") ? $("token").value : "";
        var trial = { serverUrl: api.normalizeBaseUrl(url), token: token.trim() };
        showMsg("settings-msg", "Testing…", "");
        api.createClient(trial).getHealth().then(function (h) {
          if (h && h.stopped) {
            showMsg("settings-msg", "Server answered but is STOPPED (unusual-activity stop). Restart the server.", "error");
          } else {
            showMsg("settings-msg",
              "OK — server v" + ((h && h.version) || "?") + ", gflow " +
              ((h && h.gflow) ? "ready" : "not ready") + ".", "ok-msg");
          }
          settings = trial;
          storageSet({ serverUrl: settings.serverUrl, token: settings.token }, function () {});
          refreshHealth();
        }).catch(function (err) {
          showMsg("settings-msg", err ? err.message : "Connection failed.", "error");
        });
      });
      var refreshAccountsBtn = $("refresh-accounts");
      if (refreshAccountsBtn) refreshAccountsBtn.addEventListener("click", refreshAccounts);
      var refreshJobsBtn = $("refresh-jobs");
      if (refreshJobsBtn) refreshJobsBtn.addEventListener("click", refreshJobs);
      var sendBtn = $("send-job");
      if (sendBtn) sendBtn.addEventListener("click", sendJob);
    } catch (e) {}

    // Load saved settings, then populate everything.
    loadSettings(function (s) {
      settings = s;
      try {
        if ($("server-url")) $("server-url").value = settings.serverUrl || "";
        if ($("token")) $("token").value = settings.token || "";
      } catch (e) {}
      refreshHealth();
      refreshAccounts();
      refreshJobs();
    });

    // Auto-poll jobs every 5s ONLY while the popup is open.
    try {
      pollTimer = setInterval(function () { refreshJobs(); }, 5000);
      window.addEventListener("unload", function () {
        try { if (pollTimer) clearInterval(pollTimer); } catch (e) {}
      });
    } catch (e) {}
  }

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  } catch (e) {
    try { init(); } catch (e2) {}
  }
})();
