// Flow Remote — content-panel.js (v1.1.1)
// In-page panel UI for Orion iOS. The MV3 default_popup never appears on
// Orion iOS, so this content script is the PRIMARY UI: a floating button +
// Shadow-DOM panel injected on flow.google.com, with the full remote UI
// (background health, status, settings, account picker, job form, job
// list). The popup files stay as the desktop fallback.
//
// Injection style copied from the sibling Flow Capture Observer v1.3.0,
// which works live on Orion iOS: floating button bottom-right, fixed
// positioning, createElement + addEventListener only (never inline handlers
// or injected <script>), never patch Object.prototype. Differences, both
// per the Orion UI research report: the observer uses plain DOM in
// document.body; this panel uses a Shadow DOM hosted on documentElement
// (survives the page replacing <body>, Flow's CSS cannot restyle it) and
// sets styles via CSSOM assignments (el.style) exactly like the observer —
// a <style> element would be subject to the page CSP, CSSOM assignments
// are not. One small <style> block IS included for the job-row classes
// (badges etc. from api.js); if the page CSP blocks it, only the badges
// lose styling — the panel itself keeps working.
//
// All server traffic goes through the background via chrome.runtime
// messaging (content scripts are subject to the page's CORS/CSP; the
// background fetch with host_permissions is not). State lives only in
// chrome.storage.local. No webRequest, no background timers, no polling
// in the background — the 5 s job poll runs here, only while the panel
// is open.
//
// Business logic is ported as-is from popup.js; only the shell changed:
// popup document -> shadow-root panel, direct fetch -> background proxy.

(function () {
  "use strict";

  // Self-contained in v1.1.1: the pure helpers below are inlined from
  // api.js so this content script is a SINGLE file with no cross-file
  // global dependency (Orion iOS failed to load the two-file entry).
  // The popup still loads api.js itself on desktop; the logic is
  // identical, just duplicated for robustness on Orion.

  var IMAGE_MODELS = [
    { value: "nano2", label: "Nano Banana 2 (cheapest)" },
    { value: "nano-pro", label: "Nano Banana Pro" },
    { value: "nano2-lite", label: "Nano Banana 2 Lite" },
    { value: "imagen4", label: "Imagen 4" }
  ];

  var VIDEO_MODELS = [
    { value: "veo-lite", label: "Veo Lite (cheapest)" },
    { value: "veo-fast", label: "Veo Fast" },
    { value: "omni-flash", label: "Omni Flash" }
  ];

  var IMAGE_ASPECTS = ["9:16", "16:9", "1:1", "4:3", "3:4"];

  var VIDEO_ASPECTS = ["9:16", "16:9"];

  function normalizeBaseUrl(url) {
    if (typeof url !== "string") return "";
    return url.trim().replace(/\/+$/, "");
  }

  function apiError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function truncate(s, n) {
    var str = String(s == null ? "" : s);
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }

  function jobRowHtml(job) {
    var status = (job && job.status) || "unknown";
    var kind = escapeHtml(job && job.kind ? job.kind : "?");
    var prompt = escapeHtml(truncate(job && job.prompt ? job.prompt : "(no prompt)", 80));
    var profile = escapeHtml(job && job.profile ? job.profile : "");
    var id = escapeHtml(job && job.id ? job.id : "");
    var err = job && (job.error || job.error_code)
      ? escapeHtml([job.error_code, job.error].filter(Boolean).join(": "))
      : "";
    var html = '<div class="job job-' + escapeHtml(status) + '" data-job-id="' + id + '">' +
      '<div class="job-head"><span class="badge badge-' + escapeHtml(status) + '">' +
      escapeHtml(status) + '</span> <b>' + kind + '</b> ' + prompt + '</div>' +
      '<div class="job-meta">' + (profile ? "Profile: " + profile + " · " : "") +
      (id ? "ID: " + id : "") + '</div>';
    if (err) html += '<div class="job-error">' + err + '</div>';
    if (status === "blocked") {
      html += '<div class="job-blocked">⚠️ Flow flagged unusual activity on this job. ' +
        'Do NOT resend it — stop and restart the server.</div>';
    }
    var media = job && job.results && Array.isArray(job.results.media) ? job.results.media : [];
    if (status === "done" && media.length) {
      html += '<div class="media">';
      media.forEach(function (m, i) {
        var url = m && m.url ? String(m.url) : "";
        var mKind = m && m.kind ? String(m.kind) : "media";
        if (!url) return;
        html += '<div class="media-item"><span>' + escapeHtml(mKind) + ' ' + (i + 1) + '</span> ' +
          '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Open</a> ' +
          '<button type="button" class="copy-btn" data-url="' + escapeHtml(url) + '">Copy URL</button> ' +
          '<button type="button" class="dl-btn" data-url="' + escapeHtml(url) + '">Download</button></div>';
      });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function jobListHtml(jobs) {
    if (!Array.isArray(jobs) || !jobs.length) {
      return '<div class="empty">No jobs yet.</div>';
    }
    return jobs.map(jobRowHtml).join("");
  }

  function modelOptionsForKind(kind) {
    return kind === "video" ? VIDEO_MODELS.slice() : IMAGE_MODELS.slice();
  }

  function defaultModelForKind(kind) {
    return kind === "video" ? "veo-lite" : "nano2";
  }

  function aspectOptionsForKind(kind) {
    return kind === "video" ? VIDEO_ASPECTS.slice() : IMAGE_ASPECTS.slice();
  }

  function durationOptionsForModel(model) {
    var opts = [{ value: "8", label: "8s" }];
    if (model === "omni-flash") opts.push({ value: "10", label: "10s (Omni Flash only)" });
    return opts;
  }

  // Double-injection guard (Orion may run content scripts twice).
  try {
    if (window.__flowRemotePanelInstalled) return;
    window.__flowRemotePanelInstalled = true;
  } catch (e) {}

  var PING_TIMEOUT_MS = 2000;
  var API_TIMEOUT_MS = 15000;
  var POLL_MS = 5000;
  var MAX_CACHED_JOBS = 50;

  var settings = { serverUrl: "", token: "" };
  var accounts = [];
  var pollTimer = null;
  var shadowRoot = null;
  var hostEl = null;
  var btnEl = null;
  var panelEl = null;
  var panelOpen = false;
  var suppressClickUntil = 0;

  // ---- DOM helpers (observer style: createElement + CSSOM styles) ----

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

  function $(id) {
    try { return shadowRoot ? shadowRoot.getElementById(id) : null; } catch (e) { return null; }
  }

  function setText(id, text) {
    var el = $(id);
    if (el) { try { el.textContent = text; } catch (e) {} }
  }

  function setHtml(id, html) {
    var el = $(id);
    if (el) { try { el.innerHTML = html; } catch (e) {} }
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
    var el = $(id);
    if (!el) return;
    try {
      el.textContent = "";
      el.className = cls || "";
      var s = cls ? MSG_STYLES[cls] : null;
      el.style.background = s ? s.background : "transparent";
      el.style.color = s ? s.color : "#111";
      el.style.border = s ? s.border : "1px solid transparent";
      el.style.borderRadius = "8px";
      el.style.padding = text ? "8px" : "0";
      el.style.fontSize = "13px";
      el.style.margin = "8px 0";
      el.style.whiteSpace = "pre-wrap";
      if (text) el.textContent = text;
    } catch (e) {}
  }

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
  // Same shape as popup.js: the background may be suspended, so never wait
  // on it forever.
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

  // ---- background messaging (the fetch proxy) ----

  function sendMessageWithTimeout(msg, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      var finishOk = function (res) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(res || null);
      };
      var finishErr = function (err) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      };
      try {
        if (typeof chrome === "undefined" || !chrome.runtime ||
            typeof chrome.runtime.sendMessage !== "function") {
          finishErr(apiError("network",
            "Extension messaging is unavailable (background not running). Reload the page."));
          return;
        }
        timer = setTimeout(function () {
          finishErr(apiError("network",
            "Background did not answer — it may be suspended. Reload the page."));
        }, timeoutMs || API_TIMEOUT_MS);
        chrome.runtime.sendMessage(msg, function (res) {
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              finishErr(apiError("network",
                "Background did not answer (messaging error). Reload the page."));
              return;
            }
          } catch (e) {}
          finishOk(res);
        });
      } catch (e) {
        finishErr(apiError("network",
          "Could not reach the background: " + (e && e.message ? e.message : "unknown error")));
      }
    });
  }

  // One message in, one fetch in the background, one reply back.
  function apiCall(method, path, body, settingsOverride) {
    var s = settingsOverride || settings;
    return sendMessageWithTimeout(
      { type: "api", method: method, path: path, body: body === undefined ? null : body, settings: s },
      API_TIMEOUT_MS
    ).then(function (res) {
      if (!res) {
        throw apiError("network", "Background did not answer. Reload the page and try again.");
      }
      if (res.ok) return res.data;
      throw apiError(res.code || "server", res.message || "Server error.");
    });
  }

  function proxyClient() {
    return {
      getHealth: function () { return apiCall("GET", "/health"); },
      getAccounts: function () { return apiCall("GET", "/accounts"); },
      listJobs: function () { return apiCall("GET", "/jobs"); },
      getJob: function (id) {
        return apiCall("GET", "/jobs/" + encodeURIComponent(String(id)));
      },
      // Never called for a blocked job: the UI never auto-retries or
      // auto-resubmits a job whose status is "blocked". Callers must check
      // isBlockedJob() before calling this for a re-send.
      createJob: function (job) { return apiCall("POST", "/jobs", job); }
    };
  }

  // ---- background health: beacon (storage) + ping (message) ----

  function setBeaconLine(state, beacon) {
    var el = $("fr-bg-health");
    if (!el) return;
    try {
      var text = "Background: " + state;
      if (beacon && beacon.startedAt) text += " · started " + beacon.startedAt;
      el.textContent = text;
      var colors = {
        "RUNNING": { background: "#dcf5dd", color: "#145a1a" },
        "NOT RESPONDING": { background: "#fff3cd", color: "#6b4e00" },
        "NEVER STARTED": { background: "#fde2e2", color: "#8a1a1a" }
      };
      var c = colors[state] || colors["NEVER STARTED"];
      el.style.background = c.background;
      el.style.color = c.color;
      el.style.padding = "8px";
      el.style.borderRadius = "8px";
      el.style.fontWeight = "bold";
      el.style.fontSize = "13px";
      var hint = $("fr-bg-hint");
      if (hint) {
        hint.textContent = state === "RUNNING" ? "" :
          "Background not responding — reload the page, or close and reopen Orion. " +
          "If it stays like this, the extension did not start.";
      }
    } catch (e) {}
  }

  function refreshBeacon() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (state, beacon) {
        if (done) return;
        done = true;
        setBeaconLine(state, beacon);
        resolve(state);
      };
      storageGet({ flowRemoteBeacon: null }, function (res) {
        var beacon = res && res.flowRemoteBeacon ? res.flowRemoteBeacon : null;
        var answered = false;
        var timer = setTimeout(function () {
          if (!answered) finish(beacon ? "NOT RESPONDING" : "NEVER STARTED", beacon);
        }, PING_TIMEOUT_MS);
        try {
          if (typeof chrome !== "undefined" && chrome.runtime &&
              typeof chrome.runtime.sendMessage === "function") {
            chrome.runtime.sendMessage({ type: "ping" }, function (pingRes) {
              if (answered) return;
              answered = true;
              clearTimeout(timer);
              try { void chrome.runtime.lastError; } catch (e) {}
              finish(pingRes && pingRes.alive ? "RUNNING" :
                (beacon ? "NOT RESPONDING" : "NEVER STARTED"), beacon);
            });
          } else {
            clearTimeout(timer);
            finish(beacon ? "NOT RESPONDING" : "NEVER STARTED", beacon);
          }
        } catch (e) {
          clearTimeout(timer);
          finish(beacon ? "NOT RESPONDING" : "NEVER STARTED", beacon);
        }
      });
    });
  }

  // ---- panel business logic (ported from popup.js) ----

  function selectedKind() {
    try {
      var checked = shadowRoot.querySelector('input[name="fr-kind"]:checked');
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
    fillSelect("fr-model", modelOptionsForKind(kind), defaultModelForKind(kind));
    fillSelect("fr-aspect", aspectOptionsForKind(kind), "9:16");
    fillSelect("fr-duration", durationOptionsForModel($("fr-model") ? $("fr-model").value : defaultModelForKind(kind)), "8");
    var countRow = $("fr-count-row");
    var durationRow = $("fr-duration-row");
    try {
      if (countRow) countRow.style.display = kind === "video" ? "none" : "";
      if (durationRow) durationRow.style.display = kind === "video" ? "" : "none";
    } catch (e) {}
  }

  var STATUS_LABELS = {
    "connected": "Connected",
    "stopped": "Stopped (unusual activity)",
    "offline": "Offline / wrong token",
    "not-configured": "Not configured"
  };
  var STATUS_STYLES = {
    "connected": { background: "#dcf5dd", color: "#145a1a" },
    "stopped": { background: "#fde2e2", color: "#8a1a1a" },
    "offline": { background: "#fff3cd", color: "#6b4e00" },
    "not-configured": { background: "#eee", color: "#555" }
  };

  function setStatus(state, detail) {
    var el = $("fr-status");
    if (!el) return;
    try {
      el.className = state;
      el.textContent = STATUS_LABELS[state] || state;
      var s = STATUS_STYLES[state] || STATUS_STYLES["not-configured"];
      el.style.background = s.background;
      el.style.color = s.color;
      el.style.padding = "10px";
      el.style.borderRadius = "8px";
      el.style.fontWeight = "bold";
      el.style.marginBottom = "8px";
      setText("fr-status-detail", detail || "");
    } catch (e) {}
  }

  function refreshHealth() {
    if (!settings.serverUrl || !settings.token) {
      setStatus("not-configured", "Enter the server URL and pairing token in Settings.");
      return Promise.resolve(null);
    }
    return proxyClient().getHealth().then(function (h) {
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
    var select = $("fr-account");
    if (!settings.serverUrl || !settings.token) {
      if (select) { try { select.innerHTML = ""; } catch (e) {} }
      showMsg("fr-account-warn", "Configure the server first (Settings above).", "hint");
      return Promise.resolve([]);
    }
    return proxyClient().getAccounts().then(function (list) {
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
      showMsg("fr-account-warn", err ? err.message : "Could not load accounts.", "error");
      return [];
    });
  }

  function selectedAccount() {
    try {
      var select = $("fr-account");
      if (!select || !select.value) return null;
      for (var i = 0; i < accounts.length; i++) {
        if (accounts[i].name === select.value) return accounts[i];
      }
      return { name: select.value, session: "unknown" };
    } catch (e) { return null; }
  }

  function updateAccountWarn() {
    var a = selectedAccount();
    if (!a) { showMsg("fr-account-warn", "", ""); return; }
    if (a.session === "missing") {
      showMsg("fr-account-warn",
        "⚠️ This account has no saved session. Run this in the Codespace terminal first:\n" +
        "gflow auth login --profile " + (a.name || "") +
        "\nThe extension cannot log anyone in.", "warn");
    } else if (a.session === "unknown") {
      showMsg("fr-account-warn", "Session state unknown for this account.", "hint");
    } else {
      showMsg("fr-account-warn", "", "");
    }
  }

  function copyText(text, btn) {
    var done = function () { if (btn) { try { btn.textContent = "Copied!"; } catch (e) {} } };
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
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
    var list = $("fr-jobs-list");
    if (!settings.serverUrl || !settings.token) {
      setHtml("fr-jobs-list", '<div class="empty">Configure the server first (Settings above).</div>');
      return Promise.resolve([]);
    }
    return proxyClient().listJobs().then(function (jobs) {
      setHtml("fr-jobs-list", jobListHtml(jobs));
      wireMediaButtons(list);
      // Cache the list so a panel re-inject restores instantly.
      try {
        var cache = Array.isArray(jobs) ? jobs.slice(0, MAX_CACHED_JOBS) : [];
        storageSet({ flowRemoteJobs: cache }, function () {});
      } catch (e) {}
      return jobs;
    }).catch(function (err) {
      setHtml("fr-jobs-list", "");
      var el = $("fr-jobs-list");
      if (el) {
        try {
          var div = document.createElement("div");
          div.className = "error";
          div.textContent = err ? err.message : "Could not load jobs.";
          div.style.background = "#fde2e2";
          div.style.color = "#8a1a1a";
          div.style.border = "1px solid #d33";
          div.style.borderRadius = "8px";
          div.style.padding = "8px";
          div.style.fontSize = "13px";
          div.style.margin = "8px 0";
          el.appendChild(div);
        } catch (e) {}
      }
      return [];
    });
  }

  function renderCachedJobs() {
    storageGet({ flowRemoteJobs: [] }, function (res) {
      try {
        var jobs = res && Array.isArray(res.flowRemoteJobs) ? res.flowRemoteJobs : [];
        if (jobs.length && settings.serverUrl && settings.token) {
          setHtml("fr-jobs-list", jobListHtml(jobs));
          wireMediaButtons($("fr-jobs-list"));
        }
      } catch (e) {}
    });
  }

  function sendJob() {
    var btn = $("fr-send-job");
    var promptEl = $("fr-prompt");
    var prompt = promptEl ? promptEl.value.trim() : "";
    if (!prompt) {
      showMsg("fr-job-msg", "Type a prompt first.", "error");
      return;
    }
    var account = selectedAccount();
    if (!account) {
      showMsg("fr-job-msg", "Pick an account first (Refresh accounts).", "error");
      return;
    }
    if (account.session === "missing") {
      showMsg("fr-job-msg",
        "That account has no saved session. Run `gflow auth login --profile " +
        (account.name || "") + "` in the Codespace terminal first.", "error");
      return;
    }
    var kind = selectedKind();
    var job = {
      profile: account.name,
      kind: kind,
      prompt: prompt,
      model: $("fr-model") ? $("fr-model").value : defaultModelForKind(kind),
      aspect: $("fr-aspect") ? $("fr-aspect").value : "9:16"
    };
    if (kind === "image") {
      var count = 1;
      try { count = Math.max(1, Math.min(4, parseInt($("fr-count").value, 10) || 1)); } catch (e) {}
      job.count = count;
    } else {
      var dur = 8;
      try { dur = parseInt($("fr-duration").value, 10) || 8; } catch (e) {}
      job.duration = dur;
    }
    // NOTE: this is the ONLY place a job is ever POSTed — from an explicit
    // tap on Send job. Blocked jobs are never re-sent: there is no retry
    // loop, no auto-resubmit, and no code path that POSTs for a blocked job.
    showMsg("fr-job-msg", "", "");
    if (btn) { try { btn.disabled = true; btn.textContent = "Sending…"; } catch (e) {} }
    proxyClient().createJob(job).then(function (res) {
      showMsg("fr-job-msg",
        "Job queued — ID: " + (res && res.id ? res.id : "(no id returned)") +
        " (" + (res && res.status ? res.status : "queued") + ").", "ok-msg");
      try { if (promptEl) promptEl.value = ""; } catch (e) {}
      refreshJobs();
    }).catch(function (err) {
      showMsg("fr-job-msg", err ? err.message : "Could not send the job.", "error");
    }).finally(function () {
      if (btn) { try { btn.disabled = false; btn.textContent = "Send job"; } catch (e) {} }
    });
  }

  // ---- panel open/close + polling (only while open) ----

  function startPolling() {
    try {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(function () { refreshJobs(); }, POLL_MS);
    } catch (e) {}
  }

  function stopPolling() {
    try {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    } catch (e) {}
  }

  function setPanelOpen(open) {
    panelOpen = open;
    try {
      if (panelEl) panelEl.style.display = open ? "block" : "none";
      if (btnEl) btnEl.textContent = open ? "⚡ Flow Remote ✕" : "⚡ Flow Remote";
    } catch (e) {}
    storageSet({ flowRemotePanelOpen: open }, function () {});
    if (open) {
      refreshBeacon();
      refreshHealth();
      refreshAccounts();
      refreshJobs();
      startPolling();
    } else {
      stopPolling();
    }
  }

  function togglePanel() {
    try {
      if (Date.now() < suppressClickUntil) return; // was a drag, not a tap
      setPanelOpen(!panelOpen);
    } catch (e) {}
  }

  // ---- drag the floating button (pointer + touch, passive:false) ----

  function wireDrag(el) {
    var drag = null;
    var moved = 0;
    function begin(x, y) {
      var r = 12, b = 12;
      try {
        r = parseFloat(el.style.right) || 12;
        b = parseFloat(el.style.bottom) || 12;
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
        el.style.right = Math.max(0, drag.r - dx) + "px";
        el.style.bottom = Math.max(0, drag.b - dy) + "px";
      } catch (e) {}
      return true;
    }
    function end() {
      if (drag && moved > 8) suppressClickUntil = Date.now() + 100;
      drag = null;
    }
    try {
      el.addEventListener("pointerdown", function (ev) {
        try {
          begin(ev.clientX, ev.clientY);
          if (el.setPointerCapture) { try { el.setPointerCapture(ev.pointerId); } catch (e) {} }
        } catch (e) {}
      });
      el.addEventListener("pointermove", function (ev) {
        try { if (move(ev.clientX, ev.clientY)) ev.preventDefault(); } catch (e) {}
      });
      el.addEventListener("pointerup", function () { try { end(); } catch (e) {} });
      el.addEventListener("pointercancel", function () { try { end(); } catch (e) {} });
      el.addEventListener("touchstart", function (ev) {
        try {
          var t = ev.touches && ev.touches[0];
          if (t) begin(t.clientX, t.clientY);
        } catch (e) {}
      }, { passive: false });
      el.addEventListener("touchmove", function (ev) {
        try {
          var t = ev.touches && ev.touches[0];
          if (t && move(t.clientX, t.clientY)) ev.preventDefault();
        } catch (e) {}
      }, { passive: false });
      el.addEventListener("touchend", function () { try { end(); } catch (e) {} });
      el.addEventListener("touchcancel", function () { try { end(); } catch (e) {} });
    } catch (e) {}
  }

  // ---- build the panel DOM ----

  function buildPanel() {
    // Host on documentElement so the panel survives the page replacing
    // <body>. all: initial isolates it from Flow's CSS.
    hostEl = mk("div", null, { all: "initial" });
    try { hostEl.setAttribute("id", "fr-host"); } catch (e) {}
    try { hostEl.id = "fr-host"; } catch (e) {}
    var host = null;
    try {
      host = hostEl.attachShadow({ mode: "open" });
    } catch (e) {
      host = null;
    }
    if (!host) return false;
    shadowRoot = host;

    // Job-row classes from api.js (badges etc.). If the page CSP blocks
    // this <style>, only the badges lose styling — the shell (CSSOM) works.
    try {
      var st = document.createElement("style");
      st.textContent =
        ".badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:bold;color:#fff;background:#888;}" +
        ".badge-queued{background:#6c757d;}.badge-running{background:#1a73e8;}.badge-done{background:#188038;}" +
        ".badge-failed{background:#c5221f;}.badge-blocked{background:#b06000;}" +
        ".job{border-top:1px solid #ddd;padding:8px 0;word-break:break-word;}" +
        ".job-head{margin-bottom:3px;}.job-meta{font-size:12px;color:#666;}" +
        ".job-error{font-size:13px;color:#8a1a1a;margin-top:4px;}" +
        ".job-blocked{font-size:13px;background:#fde2e2;border:1px solid #d33;border-radius:6px;padding:6px;margin-top:4px;}" +
        ".media-item{margin:6px 0;font-size:13px;}" +
        ".media-item button,.media-item a{font-size:13px;padding:6px 10px;min-height:36px;}" +
        ".empty{color:#666;font-size:13px;padding:6px 0;}";
      shadowRoot.appendChild(st);
    } catch (e) {}

    btnEl = mk("button", "⚡ Flow Remote", {
      position: "fixed", right: "12px", bottom: "12px", zIndex: "2147483647",
      padding: "10px 14px", borderRadius: "20px", border: "1px solid #888",
      background: "#111", color: "#fff", fontSize: "14px", cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)", fontFamily: "sans-serif",
      touchAction: "none"
    }, { id: "fr-btn", type: "button" });
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
    }, { id: "fr-panel" });

    // Stop Enter/Escape from reaching Flow's editor underneath.
    panelEl.addEventListener("keydown", function (ev) {
      try {
        if (ev.key === "Enter" || ev.key === "Escape") ev.stopPropagation();
      } catch (e) {}
    });

    var head = mk("div", null, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" });
    head.appendChild(mk("strong", "Flow Remote", { flex: "1", fontSize: "17px" }));
    var closeBtn = mk("button", "✕", {
      padding: "4px 10px", cursor: "pointer", fontSize: "15px",
      border: "1px solid #888", borderRadius: "8px", background: "#f2f2f2", color: "#111",
      fontFamily: "sans-serif", minHeight: "36px"
    }, { type: "button" });
    closeBtn.addEventListener("click", function () { setPanelOpen(false); });
    head.appendChild(closeBtn);
    panelEl.appendChild(head);

    panelEl.appendChild(mk("div", "Your Codespace server does the clicking in headed Chrome. This panel only sends jobs to it.", { color: "#555", fontSize: "12px", marginBottom: "10px" }));

    var bgHealth = mk("div", "Background: …", { padding: "8px", borderRadius: "8px", fontWeight: "bold", fontSize: "13px", background: "#eee", color: "#555" }, { id: "fr-bg-health" });
    panelEl.appendChild(bgHealth);
    panelEl.appendChild(mk("div", "", HINT_STYLE, { id: "fr-bg-hint" }));

    panelEl.appendChild(mk("div", "Not configured", { padding: "10px", borderRadius: "8px", fontWeight: "bold", marginBottom: "8px", background: "#eee", color: "#555" }, { id: "fr-status" }));
    panelEl.appendChild(mk("div", "", HINT_STYLE, { id: "fr-status-detail" }));

    // Settings (collapsible).
    var settingsToggle = mk("button", "Settings — server URL & pairing token ▾", {
      width: "100%", textAlign: "left", fontSize: "14px", fontWeight: "bold",
      padding: "10px", borderRadius: "8px", border: "1px solid #ccc",
      background: "#fff", color: "#111", cursor: "pointer", fontFamily: "sans-serif",
      margin: "8px 0"
    }, { id: "fr-settings-toggle", type: "button" });
    panelEl.appendChild(settingsToggle);
    var settingsBody = mk("div", null, {}, { id: "fr-settings-body" });

    settingsBody.appendChild(mk("label", "Server URL", LABEL_STYLE, { for: "fr-server-url" }));
    var urlInput = mk("input", null, INPUT_STYLE,
      { id: "fr-server-url", type: "text", placeholder: "https://<name>-8766.app.github.dev",
        autocomplete: "off", autocapitalize: "off", autocorrect: "off",
        spellcheck: "false", inputmode: "url" });
    settingsBody.appendChild(urlInput);
    settingsBody.appendChild(mk("div", "The Codespace forwarded URL, no trailing slash.", HINT_STYLE));
    settingsBody.appendChild(mk("label", "Pairing token", LABEL_STYLE, { for: "fr-token" }));
    var tokenInput = mk("input", null, INPUT_STYLE,
      { id: "fr-token", type: "password", placeholder: "Paste the token from the Codespace terminal",
        autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
    // iOS Smart Punctuation turns " into “ ” while typing — undo it.
    tokenInput.addEventListener("input", function () {
      try {
        var v = tokenInput.value || "";
        var fixed = v.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
        if (fixed !== v) tokenInput.value = fixed;
      } catch (e) {}
    });
    settingsBody.appendChild(tokenInput);
    settingsBody.appendChild(mk("div", "The token is only stored in this browser (chrome.storage.local) and sent to your server as the X-Flow-Token header.", HINT_STYLE));
    var settingsRow = mk("div", null, { display: "flex", gap: "8px", margin: "8px 0", flexWrap: "wrap" });
    var saveBtn = mk("button", "Save", BTN_STYLE, { id: "fr-save-settings", type: "button" });
    saveBtn.style.flex = "1";
    var testBtn = mk("button", "Test connection", BTN_STYLE, { id: "fr-test-connection", type: "button" });
    testBtn.style.flex = "1";
    settingsRow.appendChild(saveBtn);
    settingsRow.appendChild(testBtn);
    settingsBody.appendChild(settingsRow);
    settingsBody.appendChild(mk("div", "", {}, { id: "fr-settings-msg" }));
    panelEl.appendChild(settingsBody);
    settingsToggle.addEventListener("click", function () {
      try {
        var open = settingsBody.style.display === "none";
        settingsBody.style.display = open ? "" : "none";
        settingsToggle.textContent = open ?
          "Settings — server URL & pairing token ▾" :
          "Settings — server URL & pairing token ▸";
      } catch (e) {}
    });

    // Account.
    panelEl.appendChild(mk("h2", "Account", { fontSize: "14px", margin: "14px 0 6px" }));
    var accRow = mk("div", null, { display: "flex", gap: "8px", margin: "8px 0", flexWrap: "wrap" });
    var accSelect = mk("select", null, INPUT_STYLE, { id: "fr-account", "aria-label": "Account" });
    accSelect.style.flex = "1";
    var accRefresh = mk("button", "Refresh", BTN_STYLE, { id: "fr-refresh-accounts", type: "button" });
    accRow.appendChild(accSelect);
    accRow.appendChild(accRefresh);
    panelEl.appendChild(accRow);
    panelEl.appendChild(mk("div", "", {}, { id: "fr-account-warn" }));

    // New job.
    panelEl.appendChild(mk("h2", "New job", { fontSize: "14px", margin: "14px 0 6px" }));
    var kindRow = mk("div", null, { display: "flex", gap: "16px", margin: "6px 0" });
    var labImg = mk("label", null, { display: "inline", fontWeight: "normal", margin: "0" });
    var radioImg = mk("input", null, {});
    radioImg.type = "radio";
    radioImg.name = "fr-kind";
    radioImg.value = "image";
    radioImg.checked = true;
    labImg.appendChild(radioImg);
    labImg.appendChild(document.createTextNode(" Image"));
    var labVid = mk("label", null, { display: "inline", fontWeight: "normal", margin: "0" });
    var radioVid = mk("input", null, {});
    radioVid.type = "radio";
    radioVid.name = "fr-kind";
    radioVid.value = "video";
    labVid.appendChild(radioVid);
    labVid.appendChild(document.createTextNode(" Video"));
    kindRow.appendChild(labImg);
    kindRow.appendChild(labVid);
    panelEl.appendChild(kindRow);

    panelEl.appendChild(mk("label", "Prompt", LABEL_STYLE, { for: "fr-prompt" }));
    var promptEl = mk("textarea", null, INPUT_STYLE, { id: "fr-prompt", placeholder: "Describe what to generate…" });
    promptEl.style.minHeight = "64px";
    panelEl.appendChild(promptEl);
    panelEl.appendChild(mk("label", "Model", LABEL_STYLE, { for: "fr-model" }));
    panelEl.appendChild(mk("select", null, INPUT_STYLE, { id: "fr-model" }));
    panelEl.appendChild(mk("label", "Aspect", LABEL_STYLE, { for: "fr-aspect" }));
    panelEl.appendChild(mk("select", null, INPUT_STYLE, { id: "fr-aspect" }));
    var countRow = mk("div", null, {}, { id: "fr-count-row" });
    countRow.appendChild(mk("label", "Count (image only)", LABEL_STYLE, { for: "fr-count" }));
    var countInput = mk("input", null, INPUT_STYLE, { id: "fr-count", type: "number", min: "1", max: "4", value: "1" });
    countRow.appendChild(countInput);
    panelEl.appendChild(countRow);
    var durRow = mk("div", null, { display: "none" }, { id: "fr-duration-row" });
    durRow.appendChild(mk("label", "Duration (video only)", LABEL_STYLE, { for: "fr-duration" }));
    durRow.appendChild(mk("select", null, INPUT_STYLE, { id: "fr-duration" }));
    panelEl.appendChild(durRow);
    var sendRow = mk("div", null, { display: "flex", gap: "8px", margin: "8px 0" });
    var sendBtn = mk("button", "Send job", BTN_STYLE, { id: "fr-send-job", type: "button" });
    sendBtn.style.background = "#1a73e8";
    sendBtn.style.color = "#fff";
    sendBtn.style.borderColor = "#1a73e8";
    sendBtn.style.width = "100%";
    sendBtn.style.fontWeight = "bold";
    sendRow.appendChild(sendBtn);
    panelEl.appendChild(sendRow);
    panelEl.appendChild(mk("div", "", {}, { id: "fr-job-msg" }));

    // Jobs.
    panelEl.appendChild(mk("h2", "Jobs", { fontSize: "14px", margin: "14px 0 6px" }));
    var jobsRow = mk("div", null, { display: "flex", gap: "8px", margin: "8px 0", flexWrap: "wrap" });
    var jobsRefresh = mk("button", "Refresh jobs", BTN_STYLE, { id: "fr-refresh-jobs", type: "button" });
    jobsRefresh.style.flex = "1";
    jobsRow.appendChild(jobsRefresh);
    panelEl.appendChild(jobsRow);
    panelEl.appendChild(mk("div", "", {}, { id: "fr-jobs-list" }));

    panelEl.appendChild(mk("footer", "Server does the clicking in the Codespace. Never paste your Google password here. If a job says blocked, stop and restart the server.", { marginTop: "16px", borderTop: "1px solid #ddd", paddingTop: "8px", fontSize: "12px", color: "#555" }));

    shadowRoot.appendChild(panelEl);

    try {
      document.documentElement.appendChild(hostEl);
    } catch (e) {
      return false;
    }
    return true;
  }

  // ---- wire + init ----

  function init() {
    if (!buildPanel()) return;

    try {
      shadowRoot.querySelectorAll('input[name="fr-kind"]').forEach(function (r) {
        r.addEventListener("change", refreshModelLists);
      });
      var modelEl = $("fr-model");
      if (modelEl) {
        modelEl.addEventListener("change", function () {
          var kind = selectedKind();
          if (kind === "video") {
            fillSelect("fr-duration", durationOptionsForModel(modelEl.value), "8");
          }
        });
      }
      var accountEl = $("fr-account");
      if (accountEl) accountEl.addEventListener("change", updateAccountWarn);
    } catch (e) {}

    refreshModelLists();

    try {
      var saveBtn = $("fr-save-settings");
      if (saveBtn) saveBtn.addEventListener("click", function () {
        var url = $("fr-server-url") ? $("fr-server-url").value : "";
        var token = $("fr-token") ? $("fr-token").value : "";
        settings.serverUrl = normalizeBaseUrl(url);
        settings.token = token.trim();
        storageSet({ serverUrl: settings.serverUrl, token: settings.token }, function () {
          showMsg("fr-settings-msg", "Saved.", "ok-msg");
          refreshHealth();
          refreshAccounts();
          refreshJobs();
        });
      });
      var testBtn = $("fr-test-connection");
      if (testBtn) testBtn.addEventListener("click", function () {
        var url = $("fr-server-url") ? $("fr-server-url").value : "";
        var token = $("fr-token") ? $("fr-token").value : "";
        var trial = { serverUrl: normalizeBaseUrl(url), token: token.trim() };
        showMsg("fr-settings-msg", "Testing…", "");
        apiCall("GET", "/health", null, trial).then(function (h) {
          if (h && h.stopped) {
            showMsg("fr-settings-msg", "Server answered but is STOPPED (unusual-activity stop). Restart the server.", "error");
          } else {
            showMsg("fr-settings-msg",
              "OK — server v" + ((h && h.version) || "?") + ", gflow " +
              ((h && h.gflow) ? "ready" : "not ready") + ".", "ok-msg");
          }
          settings = trial;
          storageSet({ serverUrl: settings.serverUrl, token: settings.token }, function () {});
          refreshHealth();
        }).catch(function (err) {
          showMsg("fr-settings-msg", err ? err.message : "Connection failed.", "error");
        });
      });
      var refreshAccountsBtn = $("fr-refresh-accounts");
      if (refreshAccountsBtn) refreshAccountsBtn.addEventListener("click", refreshAccounts);
      var refreshJobsBtn = $("fr-refresh-jobs");
      if (refreshJobsBtn) refreshJobsBtn.addEventListener("click", refreshJobs);
      var sendBtn = $("fr-send-job");
      if (sendBtn) sendBtn.addEventListener("click", sendJob);
    } catch (e) {}

    // Load saved settings, then populate everything.
    loadSettings(function (s) {
      settings = s;
      try {
        if ($("fr-server-url")) $("fr-server-url").value = settings.serverUrl || "";
        if ($("fr-token")) $("fr-token").value = settings.token || "";
      } catch (e) {}
      // Collapse Settings when already configured; keep it open otherwise.
      try {
        var body = $("fr-settings-body");
        var toggle = $("fr-settings-toggle");
        if (body && toggle && settings.serverUrl && settings.token) {
          body.style.display = "none";
          toggle.textContent = "Settings — server URL & pairing token ▸";
        }
      } catch (e) {}
      refreshBeacon();
      refreshHealth();
      refreshAccounts();
      renderCachedJobs();
      refreshJobs();
    });

    // Restore the panel open/closed state.
    storageGet({ flowRemotePanelOpen: false }, function (res) {
      try {
        if (res && res.flowRemotePanelOpen) setPanelOpen(true);
      } catch (e) {}
    });

    // Stop polling when the page goes away.
    try {
      window.addEventListener("unload", function () {
        try { stopPolling(); } catch (e) {}
      });
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
          refreshBeacon: refreshBeacon,
          refreshHealth: refreshHealth,
          refreshAccounts: refreshAccounts,
          refreshJobs: refreshJobs,
          sendJob: sendJob,
          setPanelOpen: setPanelOpen,
          getSettings: function () { return { serverUrl: settings.serverUrl, token: settings.token }; },
          getShadowRoot: function () { return shadowRoot; },
          isPanelOpen: function () { return panelOpen; }
        }
      };
    }
  } catch (e) {}
})();
