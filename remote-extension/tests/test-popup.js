// Flow Remote — node test for the popup's API-client logic (api.js).
// NOT shipped in the extension ZIP. Run: node tests/test-popup.js
// Uses mocked chrome + mocked fetch with canned server responses.
// Covers the brief's required cases:
//   1. token header sent on every call
//   2. 401 -> wrong-token message
//   3. 503 stopped -> stopped message
//   4. job list renders a done job with media URLs
//   5. blocked job is never re-sent (no POST issued for it)

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

const SETTINGS = { serverUrl: "https://test-8766.app.github.dev/", token: "secret-token-123" };

(async function main() {
  // 1. Token header sent on every call (all four endpoints).
  await check("token header sent on GET /health, GET /accounts, GET /jobs, POST /jobs", async () => {
    const calls = [];
    const client = api.createClient(SETTINGS, cannedFetchFactory(calls));
    await client.getHealth();
    await client.getAccounts();
    await client.listJobs();
    await client.createJob({ profile: "main", kind: "image", prompt: "x", model: "nano2", aspect: "9:16", count: 1 });
    assert.strictEqual(calls.length, 4, "expected 4 calls, got " + calls.length);
    for (const c of calls) {
      assert.strictEqual(c.opts.headers["X-Flow-Token"], "secret-token-123", "missing/wrong token on " + c.url);
    }
    assert.ok(calls[0].url.startsWith("https://test-8766.app.github.dev/health"), "trailing slash not stripped: " + calls[0].url);
    assert.strictEqual(calls[3].opts.headers["Content-Type"], "application/json");
    const sent = JSON.parse(calls[3].opts.body);
    assert.strictEqual(sent.prompt, "x");
  });

  // 2. 401 -> wrong-token message.
  await check("401 surfaces as wrong-token message", async () => {
    const bad = async () => ({ status: 401, json: async () => ({ error: "bad token" }) });
    const client = api.createClient(SETTINGS, bad);
    let err = null;
    try { await client.getHealth(); } catch (e) { err = e; }
    assert.ok(err, "expected an error");
    assert.strictEqual(err.code, "wrong_token");
    assert.match(err.message, /token/i);
    assert.match(err.message, /re-copy/i);
  });

  // 3. 503 stopped -> stopped message.
  await check("503 surfaces as stopped message", async () => {
    const stopped = async () => ({ status: 503, json: async () => ({ error: "stopped" }) });
    const client = api.createClient(SETTINGS, stopped);
    let err = null;
    try { await client.getHealth(); } catch (e) { err = e; }
    assert.ok(err, "expected an error");
    assert.strictEqual(err.code, "stopped");
    assert.match(err.message, /stop/i);
    assert.match(err.message, /restart/i);
  });

  // 4. Job list renders a done job with media URLs.
  await check("job list renders done job with media URLs + Open/Copy/Download", async () => {
    const calls = [];
    const client = api.createClient(SETTINGS, cannedFetchFactory(calls));
    const jobs = await client.listJobs();
    assert.strictEqual(jobs.length, 3);
    const html = api.jobListHtml(jobs);
    assert.ok(html.includes("https://example.com/media/cat.png"), "media URL missing from HTML");
    assert.ok(html.includes("Open"), "Open link missing");
    assert.ok(html.includes("Copy URL"), "Copy URL button missing");
    assert.ok(html.includes("Download"), "Download button missing");
    assert.ok(html.includes("badge-done"), "done badge missing");
    assert.ok(html.includes("a cat in a hat"), "prompt missing");
  });

  // 5. Blocked job is never re-sent (no POST issued for it).
  await check("blocked job never re-sent: listing/rendering a blocked job issues no POST", async () => {
    const calls = [];
    const client = api.createClient(SETTINGS, cannedFetchFactory(calls));
    const jobs = await client.listJobs();
    const blocked = jobs.find((j) => j.status === "blocked");
    assert.ok(blocked, "no blocked job in canned list");
    assert.ok(api.isBlockedJob(blocked), "isBlockedJob should be true");
    // Render it (what the popup does) — rendering must not trigger any POST.
    const html = api.jobRowHtml(blocked);
    assert.ok(html.includes("Do NOT resend"), "blocked warning missing from row HTML");
    const posts = calls.filter((c) => (c.opts && c.opts.method) === "POST");
    assert.strictEqual(posts.length, 0, "a POST was issued while handling a blocked job");
    // And the only POST path (createJob) is never called for a blocked job:
    // the popup has no retry loop — verify by source inspection.
    const popupSrc = fs.readFileSync(path.join(EXT_DIR, "popup.js"), "utf8");
    assert.ok(!/setTimeout\(\s*function[^}]*createJob/.test(popupSrc), "popup schedules a createJob retry");
    assert.ok(!/retry/i.test(popupSrc.replace(/never.*retry/gi, "")), "popup mentions retry logic");
    assert.ok(popupSrc.includes("never re-sent") || popupSrc.includes("never auto-retry"), "popup lacks the no-resend note");
  });

  // Extras: error mapping + model/duration rules + base URL + 201 create.
  await check("POST /jobs 201 returns id + queued", async () => {
    const calls = [];
    const client = api.createClient(SETTINGS, cannedFetchFactory(calls));
    const res = await client.createJob({ profile: "main", kind: "image", prompt: "x" });
    assert.strictEqual(res.id, "job-new-9");
    assert.strictEqual(res.status, "queued");
  });

  await check("404 maps to not_found; 400 maps to validation with server message", async () => {
    const f404 = async () => ({ status: 404, json: async () => ({ error: "unknown profile" }) });
    let err = null;
    try { await api.createClient(SETTINGS, f404).createJob({}); } catch (e) { err = e; }
    assert.ok(err && err.code === "not_found" && /unknown profile/.test(err.message));
    const f400 = async () => ({ status: 400, json: async () => ({ error: "prompt is required" }) });
    err = null;
    try { await api.createClient(SETTINGS, f400).createJob({}); } catch (e) { err = e; }
    assert.ok(err && err.code === "validation" && /prompt is required/.test(err.message));
  });

  await check("network failure maps to network error (no throw of raw TypeError)", async () => {
    const boom = async () => { throw new TypeError("Failed to fetch"); };
    let err = null;
    try { await api.createClient(SETTINGS, boom).getHealth(); } catch (e) { err = e; }
    assert.ok(err && err.code === "network");
  });

  await check("missing settings -> not_configured, no fetch attempted", async () => {
    const calls = [];
    const client = api.createClient({ serverUrl: "", token: "" }, cannedFetchFactory(calls));
    let err = null;
    try { await client.getHealth(); } catch (e) { err = e; }
    assert.ok(err && err.code === "not_configured");
    assert.strictEqual(calls.length, 0);
  });

  await check("model defaults: image nano2, video veo-lite; 10s only for omni-flash", () => {
    assert.strictEqual(api.defaultModelForKind("image"), "nano2");
    assert.strictEqual(api.defaultModelForKind("video"), "veo-lite");
    assert.deepStrictEqual(api.modelOptionsForKind("image").map((m) => m.value), ["nano2", "nano-pro", "nano2-lite", "imagen4"]);
    assert.deepStrictEqual(api.modelOptionsForKind("video").map((m) => m.value), ["veo-lite", "veo-fast", "omni-flash"]);
    assert.deepStrictEqual(api.durationOptionsForModel("veo-lite").map((d) => d.value), ["8"]);
    assert.deepStrictEqual(api.durationOptionsForModel("omni-flash").map((d) => d.value), ["8", "10"]);
    assert.deepStrictEqual(api.aspectOptions(), ["9:16", "16:9", "1:1", "4:3", "3:4"]);
  });

  await check("normalizeBaseUrl strips trailing slashes / whitespace", () => {
    assert.strictEqual(api.normalizeBaseUrl("https://x.app.github.dev///  "), "https://x.app.github.dev");
    assert.strictEqual(api.normalizeBaseUrl(""), "");
  });

  // background.js loads in node with mocked chrome and answers getSettings.
  await check("background.js loads with mocked chrome, getSettings answers from storage", async () => {
    const store = { serverUrl: "https://bg.app.github.dev", token: "bg-token" };
    let listener = null;
    global.chrome = {
      storage: { local: { get: (keys, cb) => cb(Object.assign({}, store)), set: (o, cb) => { Object.assign(store, o); if (cb) cb(); } } },
      runtime: {
        lastError: undefined,
        onMessage: { addListener: (fn) => { listener = fn; } }
      }
    };
    delete require.cache[require.resolve(path.join(EXT_DIR, "background.js"))];
    require(path.join(EXT_DIR, "background.js"));
    assert.ok(typeof listener === "function", "onMessage listener not registered");
    const reply = await new Promise((resolve) => {
      listener({ type: "getSettings" }, {}, (res) => resolve(res));
    });
    assert.ok(reply && reply.ok && reply.settings.serverUrl === "https://bg.app.github.dev");
    delete global.chrome;
  });

  // popup.js loads in node with no DOM and no chrome (must not throw).
  await check("popup.js loads in node with no DOM (guarded, no throw)", () => {
    delete require.cache[require.resolve(path.join(EXT_DIR, "popup.js"))];
    require(path.join(EXT_DIR, "popup.js")); // returns early: no document
  });

  // Manifest + referenced files exist; no webRequest anywhere in the extension.
  await check("manifest parses; every referenced file exists; no webRequest in extension", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
    assert.strictEqual(manifest.manifest_version, 3);
    assert.strictEqual(manifest.name, "Flow Remote");
    assert.strictEqual(manifest.version, "1.1.1");
    assert.deepStrictEqual(manifest.permissions, ["storage"]);
    assert.ok(Array.isArray(manifest.background.scripts) && manifest.background.scripts.includes("background.js"));
    assert.strictEqual(manifest.background.service_worker, "background.js");
    const refs = [manifest.action.default_popup, manifest.background.service_worker,
      ...manifest.background.scripts, ...Object.values(manifest.icons)];
    for (const r of refs) {
      assert.ok(fs.existsSync(path.join(EXT_DIR, r)), "manifest references missing file: " + r);
    }
    assert.ok(fs.existsSync(path.join(EXT_DIR, "api.js")), "api.js missing");
    assert.ok(fs.existsSync(path.join(EXT_DIR, "README.md")), "README.md missing");
    for (const f of ["manifest.json", "background.js", "popup.js", "popup.html", "api.js"]) {
      const src = fs.readFileSync(path.join(EXT_DIR, f), "utf8");
      assert.ok(!/webRequest/.test(src) || /no webRequest/i.test(src) || f === "background.js" && /No webRequest/.test(src),
        "webRequest found in " + f);
      // Strict: only comments may mention webRequest.
      const codeLines = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l.trim()));
      assert.ok(!codeLines.some((l) => /webRequest/.test(l)), "webRequest in code of " + f);
    }
    const popupHtml = fs.readFileSync(path.join(EXT_DIR, "popup.html"), "utf8");
    assert.ok(popupHtml.includes('src="api.js"') && popupHtml.includes('src="popup.js"'), "popup.html must load api.js then popup.js");
  });

  console.log("\n" + pass + " passed, " + fail + " failed.");
  if (fail) {
    console.log("Failures:\n- " + failures.join("\n- "));
    process.exit(1);
  }
})().catch((e) => { console.error("Test harness crashed:", e); process.exit(2); });
