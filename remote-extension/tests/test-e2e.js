// End-to-end MOCK test: real server.py + stub gflow + real extension api.js.
// No contact with flow.google.com, no credits. Run from the staging root:
//   node tests/test-e2e.js
// Exit 0 = PASS, 1 = FAIL.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const STAGING = path.join(__dirname, "..", "..");
const api = require(path.join(STAGING, "remote-extension", "api.js"));

const failures = [];
function check(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failures.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flow-e2e-"));
  const stubDir = path.join(tmp, "bin");
  fs.mkdirSync(stubDir);
  const stub = path.join(stubDir, "gflow");
  fs.writeFileSync(stub, `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo '[{"name":"test-main","google_account":"testmain@example.com","is_default":true,"cookies_present":true,"last_used_at":"2026-11-07T00:00:00Z","profile_dir":"/tmp/x"},{"name":"test-second","google_account":"unknowjason20@gmail.com","is_default":false,"cookies_present":true,"last_used_at":"2026-11-07T00:00:00Z","profile_dir":"/tmp/y"}]'
  exit 0
fi
case "$*" in
  *BLOCKME*) echo "PUBLIC_ERROR_UNUSUAL_ACTIVITY" >&2; exit 1;;
esac
sleep 0.3
if [ "$1" = "image" ]; then
  echo '{"images":[{"fife_url":"https://example.com/media/img1.png","local_path":"/tmp/out/img1.png","media_id":"m1"}]}'
  exit 0
fi
if [ "$1" = "video" ]; then
  echo '{"local_path":"/tmp/out/clip1.mp4","media_id":"v1"}'
  exit 0
fi
echo "unknown command" >&2; exit 2
`);
  fs.chmodSync(stub, 0o755);

  const jobsPath = path.join(tmp, "jobs.json");
  const env = {
    ...process.env,
    PATH: stubDir + ":" + process.env.PATH,
    FLOW_SERVER_TOKEN: "e2e-token",
    FLOW_JOBS_PATH: jobsPath,
    FLOW_PORT: "0",
  };
  const server = spawn("python3", [path.join(STAGING, "server", "server.py")], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (d) => { out += d.toString(); });
  server.stderr.on("data", (d) => { out += d.toString(); });

  let port = 0;
  for (let i = 0; i < 50 && !port; i++) {
    const m = out.match(/listening on 0\.0\.0\.0:(\d+)/);
    if (m) port = Number(m[1]);
    else await sleep(100);
  }
  check("server started and printed its port", port > 0);
  if (!port) { console.log(out); server.kill(); process.exit(1); }

  const settings = { serverUrl: "http://127.0.0.1:" + port, token: "e2e-token" };
  const client = api.createClient(settings);
  const badClient = api.createClient({ serverUrl: settings.serverUrl, token: "wrong" });

  try {
    const health = await client.getHealth();
    check("GET /health ok + gflow found", health.ok === true && health.gflow === true);

    try { await badClient.getHealth(); check("wrong token -> 401", false); }
    catch (e) { check("wrong token -> 401", e.code === "wrong_token"); }

    const accounts = await client.getAccounts();
    check("GET /accounts returns 2 profiles", Array.isArray(accounts) && accounts.length === 2);
    check("test account listed with session present",
      accounts.some((a) => a.google_account === "unknowjason20@gmail.com" && a.session === "present"));

    // Image job end-to-end (extension client -> real server -> stub gflow).
    const created = await client.createJob({
      profile: "test-main", kind: "image", prompt: "a cat on a roof",
      model: "nano2", aspect: "9:16", count: 1,
    });
    check("POST /jobs image -> 201 queued", created && created.status === "queued" && created.id);
    let job = null;
    for (let i = 0; i < 40; i++) {
      job = await client.getJob(created.id);
      if (job.status === "done" || job.status === "failed" || job.status === "blocked") break;
      await sleep(250);
    }
    check("image job reached done", job && job.status === "done");
    check("image job has media URL from stub",
      !!(job && job.results && job.results.media && job.results.media[0] && job.results.media[0].url === "https://example.com/media/img1.png"));

    // Video job end-to-end (video has no URL, only a local path).
    const vCreated = await client.createJob({
      profile: "test-second", kind: "video", prompt: "a dog in the rain",
      model: "veo-lite", aspect: "9:16", duration: 8, count: 1,
    });
    check("POST /jobs video -> 201 queued", vCreated && vCreated.status === "queued");
    let vjob = null;
    for (let i = 0; i < 40; i++) {
      vjob = await client.getJob(vCreated.id);
      if (vjob.status === "done" || vjob.status === "failed" || vjob.status === "blocked") break;
      await sleep(250);
    }
    check("video job reached done", vjob && vjob.status === "done");
    check("video job has local_path (no URL, as gflow reports)",
      !!(vjob && vjob.results && vjob.results.media && vjob.results.media[0] && vjob.results.media[0].local_path === "/tmp/out/clip1.mp4"));

    // Validation: video with a 1:1 aspect must be rejected (server 400).
    try {
      await client.createJob({ profile: "test-main", kind: "video", prompt: "x", model: "veo-lite", aspect: "1:1", duration: 8 });
      check("video 1:1 aspect -> 400 validation", false);
    } catch (e) { check("video 1:1 aspect -> 400 validation", e.code === "validation"); }

    // Unusual-activity: blocked job + server stops, later POST gets 503.
    const bCreated = await client.createJob({
      profile: "test-main", kind: "image", prompt: "BLOCKME please",
      model: "nano2", aspect: "9:16", count: 1,
    });
    let bjob = null;
    for (let i = 0; i < 40; i++) {
      bjob = await client.getJob(bCreated.id);
      if (bjob.status === "blocked" || bjob.status === "failed" || bjob.status === "done") break;
      await sleep(250);
    }
    check("unusual-activity job -> blocked", bjob && bjob.status === "blocked");
    check("blocked job error_code is unusual_activity", bjob && bjob.error_code === "unusual_activity");
    try {
      await client.createJob({ profile: "test-main", kind: "image", prompt: "one more", model: "nano2", aspect: "9:16" });
      check("POST after stop -> 503", false);
    } catch (e) { check("POST after stop -> 503", e.code === "stopped"); }

    // Job list renders through the extension's own HTML helper.
    const jobs = await client.listJobs();
    check("GET /jobs lists all jobs newest-first", Array.isArray(jobs) && jobs.length === 3);
    const html = api.jobListHtml(jobs);
    check("extension renders blocked warning + media link in job HTML",
      html.includes("unusual activity") && html.includes("https://example.com/media/img1.png"));

    // Persistence: jobs.json on disk holds the jobs.
    const saved = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
    check("jobs.json persisted 3 jobs", Array.isArray(saved) && saved.length === 3);
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
  }

  if (failures.length) {
    console.log("\nE2E MOCK TEST FAIL (" + failures.length + " failed)");
    process.exit(1);
  }
  console.log("\nE2E MOCK TEST PASS (extension client -> real server -> stub gflow; done + blocked + stopped verified)");
}

main().catch((e) => { console.error("E2E harness error:", e); process.exit(1); });
