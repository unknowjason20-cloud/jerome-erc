// Flow Remote — api.js
// Shared API client for the Codespace server. Loaded by popup.html AND by
// the node test (tests/test-popup.js), so it must work with no DOM and no
// chrome.* at all: pure fetch + plain functions only. No webRequest, no
// contact with flow.google.com — only the user's own server URL.
//
// Server contract (fixed):
//   GET  /health  -> { ok, version, gflow, stopped, queue:{running, queued} }
//   GET  /accounts -> [{ name, google_account, session, is_default }]
//   POST /jobs { profile, kind, prompt, model?, aspect?, count?, duration? }
//        -> 201 { id, status:"queued" }; 400 / 404 / 401 / 503
//   GET  /jobs, GET /jobs/:id
//   Job status: queued | running | done | failed | blocked
//   "blocked" = Flow flagged unusual activity: NEVER auto-retry/resubmit.

(function (root) {
  "use strict";

  var TIMEOUT_MS = 15000;

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
  var VIDEO_ASPECTS = ["9:16", "16:9"]; // server (gflow t2v) only allows these two

  function aspectOptionsForKind(kind) {
    return kind === "video" ? VIDEO_ASPECTS.slice() : IMAGE_ASPECTS.slice();
  }

  function aspectOptions() { return IMAGE_ASPECTS.slice(); }

  function normalizeBaseUrl(url) {
    if (typeof url !== "string") return "";
    return url.trim().replace(/\/+$/, "");
  }

  // Error object the UI can show plainly. `code` is one of:
  // not_configured | network | timeout | wrong_token | stopped |
  // not_found | validation | server
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

  // Low-level request. fetchFn is injectable for tests; defaults to global fetch.
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

  function createClient(settings, fetchFn) {
    return {
      getHealth: function () { return request(settings, "GET", "/health", null, fetchFn); },
      getAccounts: function () { return request(settings, "GET", "/accounts", null, fetchFn); },
      listJobs: function () { return request(settings, "GET", "/jobs", null, fetchFn); },
      getJob: function (id) {
        return request(settings, "GET", "/jobs/" + encodeURIComponent(String(id)), null, fetchFn);
      },
      // Never called for a blocked job: the UI never auto-retries or
      // auto-resubmits a job whose status is "blocked". Callers must check
      // isBlockedJob() before calling this for a re-send.
      createJob: function (job) { return request(settings, "POST", "/jobs", job, fetchFn); }
    };
  }

  function isBlockedJob(job) {
    try { return !!(job && job.status === "blocked"); } catch (e) { return false; }
  }

  function modelOptionsForKind(kind) {
    return kind === "video" ? VIDEO_MODELS.slice() : IMAGE_MODELS.slice();
  }

  function defaultModelForKind(kind) {
    return kind === "video" ? "veo-lite" : "nano2";
  }

  // Duration choices for the video form. 10s exists only for omni-flash.
  function durationOptionsForModel(model) {
    var opts = [{ value: "8", label: "8s" }];
    if (model === "omni-flash") opts.push({ value: "10", label: "10s (Omni Flash only)" });
    return opts;
  }

  // NOTE: aspectOptions() with no kind is the legacy all-image list; the
  // popup uses aspectOptionsForKind(kind) so video never offers 1:1/4:3/3:4,
  // which the server rejects (gflow t2v only allows 9:16 and 16:9).

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function truncate(s, n) {
    var str = String(s == null ? "" : s);
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }

  // Pure HTML for one job row — used by the popup and by the node test.
  // Media actions are plain links/buttons; the popup wires the buttons up.
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

  var api = {
    TIMEOUT_MS: TIMEOUT_MS,
    normalizeBaseUrl: normalizeBaseUrl,
    apiError: apiError,
    errorForStatus: errorForStatus,
    request: request,
    createClient: createClient,
    isBlockedJob: isBlockedJob,
    modelOptionsForKind: modelOptionsForKind,
    defaultModelForKind: defaultModelForKind,
    durationOptionsForModel: durationOptionsForModel,
    aspectOptions: aspectOptions,
    aspectOptionsForKind: aspectOptionsForKind,
    escapeHtml: escapeHtml,
    truncate: truncate,
    jobRowHtml: jobRowHtml,
    jobListHtml: jobListHtml
  };

  // Node (test) export; browser global otherwise.
  try {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = api;
    } else {
      root.FlowRemoteApi = api;
    }
  } catch (e) {
    try { root.FlowRemoteApi = api; } catch (e2) {}
  }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
