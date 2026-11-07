#!/usr/bin/env python3
"""Flow server — HTTP front-end for gflow-cli inside a GitHub Codespace.

An extension on the user's iPhone (Orion) sends generation jobs here; this
server shells out to the ``gflow`` CLI (headed real Chrome, ui_automation
transport — the only automation method with live verifications) and returns
results. It never talks to flow.google.com directly and never replays
batchexecute requests or scripted clicks.

Stdlib only. Run via ``start.sh`` (``python3 server.py``).

Auth: a pairing token generated at startup (or ``FLOW_SERVER_TOKEN``) must be
sent as the ``X-Flow-Token`` header on EVERY route, checked with a
constant-time compare. The token is printed to stdout at startup and NEVER
written to any file (jobs.json holds no secrets).

Queue: FIFO, one job at a time, worker thread. Jobs persist to ``jobs.json``
(atomic tmp+rename) next to this file; on startup any job left ``running`` is
marked ``failed`` with error_code ``server_restarted``.

Safety: if gflow output signals unusual-activity / WAF / hijack detection,
the job is marked ``blocked`` and the server sets ``stopped=true`` — all later
``POST /jobs`` calls get 503 until the server is restarted. No auto-retry.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "1.0.0"
DEFAULT_PORT = 8766
DEFAULT_TOKEN_ENV = "FLOW_SERVER_TOKEN"
PORT_ENV = "FLOW_PORT"
JOBS_PATH_ENV = "FLOW_JOBS_PATH"  # test hook; default: jobs.json next to server.py

# Allowlists verified against `gflow image t2i --help` / `gflow video t2v --help`
# (gflow 0.93.0). Do not extend without re-checking --help.
IMAGE_MODELS = {
    "nano2", "nano21", "nano2.1", "nano-2.1",
    "nano-pro", "nano2-lite", "image4", "imagen4",
}
VIDEO_MODELS = {"omni-flash", "veo-lite", "veo-fast", "veo-quality", "veo-lite-lp"}
IMAGE_ASPECTS = {"9:16", "16:9", "1:1", "4:3", "3:4"}
VIDEO_ASPECTS = {"9:16", "16:9"}  # t2v only offers portrait/landscape
DURATIONS = {4, 6, 8, 10}
COUNTS = {1, 2, 3, 4}
MAX_PROMPT_CHARS = 2000
MAX_BODY_BYTES = 64 * 1024
LOG_TAIL_MAX = 4000
IMAGE_TIMEOUT_S = 10 * 60
VIDEO_TIMEOUT_S = 30 * 60

DEFAULT_IMAGE_MODEL = "nano2"      # cheapest image model, also gflow's default
DEFAULT_VIDEO_MODEL = "veo-lite"   # cheapest video model per brief
DEFAULT_ASPECT = "9:16"
DEFAULT_VIDEO_DURATION = 8

# Case-insensitive markers that mean Flow's anti-bot gate fired.
UNUSUAL_MARKERS = (
    "unusual_activity",
    "unusual activity",
    "extension_hijack_detected",
)

JOB_STATUSES = ("queued", "running", "done", "failed", "blocked")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def log(msg: str) -> None:
    print(f"[{now_iso()}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# State + persistence
# ---------------------------------------------------------------------------

class ServerState:
    def __init__(self, token: str, jobs_path: Path) -> None:
        self.token = token
        self.jobs_path = jobs_path
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.jobs: dict[str, dict] = {}  # id -> job record, insertion order
        self.stopped = False
        self.shutdown = False
        self.load_jobs()

    # -- persistence ------------------------------------------------------
    def load_jobs(self) -> None:
        try:
            raw = self.jobs_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except OSError as exc:
            log(f"WARN: could not read {self.jobs_path}: {exc}")
            return
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            log(f"WARN: {self.jobs_path} is not valid JSON ({exc}); starting empty")
            return
        if not isinstance(data, list):
            log(f"WARN: {self.jobs_path} is not a list; starting empty")
            return
        restarted = 0
        for rec in data:
            if not isinstance(rec, dict) or "id" not in rec:
                continue
            if rec.get("status") == "running":
                rec["status"] = "failed"
                rec["error"] = "Server restarted while this job was running."
                rec["error_code"] = "server_restarted"
                rec["finished_at"] = now_iso()
                restarted += 1
            self.jobs[rec["id"]] = rec
        if restarted:
            log(f"Marked {restarted} interrupted job(s) as failed (server_restarted)")
            self.save_jobs()
        log(f"Loaded {len(self.jobs)} job(s) from {self.jobs_path}")

    def save_jobs(self) -> None:
        """Atomic persist: write tmp file in the same dir, then rename."""
        tmp = self.jobs_path.with_suffix(".json.tmp")
        try:
            tmp.write_text(
                json.dumps(list(self.jobs.values()), indent=2),
                encoding="utf-8",
            )
            os.replace(tmp, self.jobs_path)
        except OSError as exc:
            log(f"WARN: could not persist jobs to {self.jobs_path}: {exc}")

    # -- queue ------------------------------------------------------------
    def enqueue(self, job: dict) -> None:
        with self.cond:
            self.jobs[job["id"]] = job
            self.save_jobs()
            self.cond.notify_all()

    def update(self, job: dict) -> None:
        with self.cond:
            self.jobs[job["id"]] = job
            self.save_jobs()
            self.cond.notify_all()

    def next_queued(self) -> dict | None:
        with self.cond:
            while not self.shutdown:
                for job in self.jobs.values():
                    if job["status"] == "queued":
                        return job
                self.cond.wait(timeout=1.0)
            return None

    def snapshot(self) -> list[dict]:
        with self.lock:
            jobs = sorted(
                self.jobs.values(),
                key=lambda j: j.get("created_at", ""),
                reverse=True,
            )
            return [dict(j) for j in jobs]

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job is not None else None

    def running_id(self) -> str | None:
        with self.lock:
            for job in self.jobs.values():
                if job["status"] == "running":
                    return job["id"]
        return None


# ---------------------------------------------------------------------------
# gflow wrappers
# ---------------------------------------------------------------------------

def gflow_binary() -> str | None:
    return shutil.which("gflow")


def list_accounts() -> tuple[list[dict] | None, str | None]:
    """Run `gflow auth list --json`; return (accounts, error).

    Account record: {name, google_account, session, is_default}.
    session is "present" when gflow reports cookies_present, else "missing".
    google_account may be None (gflow returns null when no .gflow_account
    file exists) — passed through as null.
    """
    binary = gflow_binary()
    if binary is None:
        return None, "gflow_missing"
    try:
        proc = subprocess.run(
            [binary, "auth", "list", "--json"],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"WARN: gflow auth list failed: {exc}")
        return None, "gflow_error"
    try:
        data = json.loads(proc.stdout.strip() or "[]")
    except json.JSONDecodeError:
        log("WARN: gflow auth list --json returned unparseable output")
        return None, "gflow_error"
    if isinstance(data, dict):
        data = data.get("profiles", [])
    accounts = []
    for p in data if isinstance(data, list) else []:
        if not isinstance(p, dict) or "name" not in p:
            continue
        accounts.append({
            "name": p["name"],
            "google_account": p.get("google_account"),
            "session": "present" if p.get("cookies_present") else "missing",
            "is_default": bool(p.get("is_default", False)),
        })
    return accounts, None


def build_argv(job: dict) -> list[str]:
    """Exact gflow argv for a validated job. Prompt is one argv element —
    never interpolated into a shell string."""
    binary = gflow_binary() or "gflow"
    if job["kind"] == "image":
        return [
            binary, "image", "t2i", job["prompt"],
            "--model", job["model"],
            "--aspect", job["aspect"],
            "-n", str(job["count"]),
            "--profile", job["profile"],
            "--json",
        ]
    return [
        binary, "video", "t2v", job["prompt"],
        "--model", job["model"],
        "--aspect", job["aspect"],
        "--duration", str(job["duration"]),
        "--count", str(job["count"]),
        "--profile", job["profile"],
        "--json",
    ]


def parse_media(stdout: str, kind: str) -> list[dict]:
    """Extract media entries from gflow --json stdout.

    Prefers the documented shapes (gflow 0.93.0 json_output.py):
      image: {images: [{fife_url, local_path, ...}]}
      video: {local_path, media_id, ...}  (video has no CDN URL)
    Falls back to regex-extracting http(s) URLs from raw stdout when the
    JSON shape is unexpected. Returns [{url, local_path?, kind}].
    """
    media: list[dict] = []
    payload = None
    text = stdout.strip()
    if text:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            # gflow may print a preamble; try the largest {...} span.
            start = text.find("{")
            end = text.rfind("}")
            if 0 <= start < end:
                try:
                    payload = json.loads(text[start:end + 1])
                except json.JSONDecodeError:
                    payload = None
    if isinstance(payload, dict):
        images = payload.get("images")
        if isinstance(images, list):
            for img in images:
                if isinstance(img, dict):
                    media.append({
                        "url": img.get("fife_url") or img.get("url"),
                        "local_path": img.get("local_path"),
                        "kind": "image",
                    })
        if kind == "video":
            local_path = payload.get("local_path")
            if local_path or payload.get("media_id"):
                media.append({
                    "url": payload.get("fife_url") or payload.get("url"),
                    "local_path": local_path,
                    "kind": "video",
                })
    if not media:
        urls = []
        for url in re.findall(r"https?://[^\s\"'<>]+", stdout):
            url = url.rstrip(".,);]")
            if url not in urls:
                urls.append(url)
        media = [{"url": u, "kind": kind} for u in urls]
    # Drop entries with neither url nor local_path.
    return [m for m in media if m.get("url") or m.get("local_path")]


def classify_failure(returncode: int, combined: str) -> tuple[str, str, bool]:
    """Return (error_code, human error, stop_server).

    Order matters: unusual-activity wins over everything else because it
    must stop the server; profile-busy and auth-expired are per-job.
    """
    low = combined.lower()
    if any(m in low for m in UNUSUAL_MARKERS) or "waf 403" in low:
        return (
            "unusual_activity",
            "Flow refused the run (unusual activity / anti-bot gate). "
            "Server stopped — no new jobs until restart.",
            True,
        )
    if returncode == 11 or "profilelocked" in low or "profile locked" in low:
        return (
            "profile_busy",
            "That profile is already busy with another generation "
            "(gflow exit 11 / ProfileLocked). Retry later.",
            False,
        )
    if "auth expired" in low or "auth login" in low or "session expired" in low:
        return (
            "auth_expired",
            "Google session for this profile expired. Run "
            "`gflow auth login --profile <name>` in the Codespace terminal, "
            "then retry.",
            False,
        )
    return (
        "gflow_error",
        f"gflow exited with code {returncode}. See log_tail.",
        False,
    )


def run_job(state: ServerState, job: dict) -> None:
    job["status"] = "running"
    job["started_at"] = now_iso()
    state.update(job)
    log(f"job {job['id']} started kind={job['kind']} profile={job['profile']} "
        f"model={job['model']}")

    argv = build_argv(job)
    timeout = IMAGE_TIMEOUT_S if job["kind"] == "image" else VIDEO_TIMEOUT_S
    stdout = ""
    stderr = ""
    returncode: int | None = None
    timed_out = False
    try:
        # Env passthrough: inherits os.environ, so GFLOW_CLI_HOME (and any
        # other gflow settings) flow through untouched.
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout,
        )
        stdout, stderr, returncode = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout = (exc.stdout or b"").decode("utf-8", "replace") \
            if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = (exc.stderr or b"").decode("utf-8", "replace") \
            if isinstance(exc.stderr, bytes) else (exc.stderr or "")
    except OSError as exc:
        stderr = f"failed to launch gflow: {exc}"

    combined = (stdout + "\n" + stderr).strip()
    job["log_tail"] = combined[-LOG_TAIL_MAX:] if combined else ""
    job["finished_at"] = now_iso()

    if timed_out:
        job["status"] = "failed"
        job["error_code"] = "timeout"
        job["error"] = (f"gflow did not finish within {timeout // 60} minutes; "
                        "killed.")
        log(f"job {job['id']} TIMEOUT after {timeout}s")
    elif returncode == 0:
        media = parse_media(stdout, job["kind"])
        job["results"] = {"media": media}
        job["status"] = "done"
        log(f"job {job['id']} done media={len(media)}")
    else:
        code, message, stop = classify_failure(returncode or 1, combined)
        job["status"] = "blocked" if code == "unusual_activity" else "failed"
        job["error_code"] = code
        # For auth_expired, name the profile so the user knows what to re-login.
        if code == "auth_expired":
            message = message.replace("<name>", job["profile"])
        job["error"] = message
        if stop:
            with state.lock:
                state.stopped = True
            log(f"job {job['id']} BLOCKED (unusual_activity) — server STOPPED")
        else:
            log(f"job {job['id']} failed code={code} rc={returncode}")
    state.update(job)


def worker_loop(state: ServerState) -> None:
    while not state.shutdown:
        job = state.next_queued()
        if job is None:
            break
        run_job(state, job)


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

def validate_job_body(body: dict, accounts: list[dict]) -> tuple[dict | None, tuple[int, dict] | None]:
    """Validate a POST /jobs body. Returns (job_fields, None) or
    (None, (http_status, error_obj)). Defaults applied per kind."""
    if not isinstance(body, dict):
        return None, (400, {"error": "invalid_body", "detail": "JSON object expected"})
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return None, (400, {"error": "invalid_prompt", "detail": "prompt must be a non-empty string"})
    if len(prompt) > MAX_PROMPT_CHARS:
        return None, (400, {"error": "invalid_prompt",
                            "detail": f"prompt exceeds {MAX_PROMPT_CHARS} characters"})
    kind = body.get("kind", "image")
    if kind not in ("image", "video"):
        return None, (400, {"error": "invalid_kind", "detail": "kind must be 'image' or 'video'"})

    if kind == "image":
        models, aspects = IMAGE_MODELS, IMAGE_ASPECTS
        default_model = DEFAULT_IMAGE_MODEL
    else:
        models, aspects = VIDEO_MODELS, VIDEO_ASPECTS
        default_model = DEFAULT_VIDEO_MODEL

    model = body.get("model", default_model)
    if model not in models:
        return None, (400, {"error": "invalid_model",
                            "detail": f"model '{model}' not valid for kind '{kind}'"})
    aspect = body.get("aspect", DEFAULT_ASPECT)
    if aspect not in aspects:
        return None, (400, {"error": "invalid_aspect",
                            "detail": f"aspect '{aspect}' not valid for kind '{kind}'"})
    count = body.get("count", 1)
    if isinstance(count, bool) or not isinstance(count, int) or count not in COUNTS:
        return None, (400, {"error": "invalid_count", "detail": "count must be an integer 1-4"})

    duration = None
    if kind == "video":
        duration = body.get("duration", DEFAULT_VIDEO_DURATION)
        if isinstance(duration, bool) or not isinstance(duration, int) or duration not in DURATIONS:
            return None, (400, {"error": "invalid_duration",
                                "detail": "duration must be one of 4, 6, 8, 10 seconds"})
    elif "duration" in body and body["duration"] is not None:
        return None, (400, {"error": "invalid_duration",
                            "detail": "duration only applies to video jobs"})

    profile = body.get("profile")
    if profile is None:
        defaults = [a["name"] for a in accounts if a.get("is_default")]
        if len(defaults) == 1:
            profile = defaults[0]
        elif len(accounts) == 1:
            profile = accounts[0]["name"]
        else:
            return None, (400, {"error": "profile_required",
                                "detail": "profile is required (no single default profile)"})
    if not isinstance(profile, str) or not profile:
        return None, (400, {"error": "invalid_profile", "detail": "profile must be a non-empty string"})
    if profile not in {a["name"] for a in accounts}:
        return None, (404, {"error": "unknown_profile",
                            "detail": f"no gflow profile named '{profile}'"})

    fields = {
        "kind": kind,
        "prompt": prompt.strip(),
        "model": model,
        "aspect": aspect,
        "count": count,
        "duration": duration,
        "profile": profile,
    }
    return fields, None


class Handler(BaseHTTPRequestHandler):
    state: ServerState  # set on the server instance; accessed via self.server
    protocol_version = "HTTP/1.1"

    # -- helpers ----------------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:  # keep stdout logging ours
        pass

    @property
    def _state(self) -> ServerState:
        return self.server.state  # type: ignore[attr-defined]

    def _send_json(self, status: int, obj: dict | list) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _auth_ok(self) -> bool:
        token = self.headers.get("X-Flow-Token") or ""
        return hmac.compare_digest(token, self._state.token)

    def _read_body(self) -> tuple[dict | None, tuple[int, dict] | None]:
        length = self.headers.get("Content-Length")
        try:
            n = int(length) if length is not None else 0
        except ValueError:
            return None, (400, {"error": "invalid_body", "detail": "bad Content-Length"})
        if n > MAX_BODY_BYTES:
            return None, (413, {"error": "body_too_large"})
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return None, (400, {"error": "invalid_body", "detail": "empty body"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, (400, {"error": "invalid_body", "detail": "body is not valid JSON"})
        return body, None

    # -- routing ----------------------------------------------------------
    def _route(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        method = self.command
        log(f"{self.client_address[0]} {method} {path}")

        if not self._auth_ok():
            self._send_json(401, {"error": "unauthorized",
                                  "detail": "missing or wrong X-Flow-Token header"})
            return

        if method == "GET" and path == "/health":
            self._send_json(200, {
                "ok": True,
                "version": VERSION,
                "gflow": gflow_binary() is not None,
                "stopped": self._state.stopped,
                "queue": {
                    "running": self._state.running_id(),
                    "queued": sum(1 for j in self._state.snapshot()
                                  if j["status"] == "queued"),
                },
            })
            return

        if method == "GET" and path == "/accounts":
            accounts, err = list_accounts()
            if err == "gflow_missing":
                self._send_json(503, {"error": "gflow_missing",
                                      "detail": "gflow binary not found on PATH"})
            elif err:
                self._send_json(503, {"error": "gflow_error",
                                      "detail": "gflow auth list failed"})
            else:
                self._send_json(200, accounts or [])
            return

        if method == "POST" and path == "/jobs":
            if self._state.stopped:
                self._send_json(503, {"error": "stopped",
                                      "reason": "Server stopped after an "
                                                "unusual-activity block. "
                                                "Restart the server to resume."})
                return
            body, err = self._read_body()
            if err is not None:
                self._send_json(err[0], err[1])
                return
            accounts, acc_err = list_accounts()
            if acc_err == "gflow_missing":
                self._send_json(503, {"error": "gflow_missing",
                                      "detail": "gflow binary not found on PATH"})
                return
            if acc_err:
                self._send_json(503, {"error": "gflow_error",
                                      "detail": "gflow auth list failed"})
                return
            fields, verr = validate_job_body(body, accounts or [])
            if verr is not None:
                self._send_json(verr[0], verr[1])
                return
            job = {
                "id": uuid.uuid4().hex[:12],
                "status": "queued",
                "created_at": now_iso(),
                "started_at": None,
                "finished_at": None,
                **fields,
            }
            self._state.enqueue(job)
            log(f"job {job['id']} queued kind={job['kind']} profile={job['profile']}")
            self._send_json(201, {"id": job["id"], "status": "queued"})
            return

        if method == "GET" and path == "/jobs":
            self._send_json(200, self._state.snapshot())
            return

        if method == "GET" and path.startswith("/jobs/"):
            job_id = path[len("/jobs/"):]
            job = self._state.get(job_id)
            if job is None:
                self._send_json(404, {"error": "not_found",
                                      "detail": f"no job '{job_id}'"})
            else:
                self._send_json(200, job)
            return

        self._send_json(404, {"error": "not_found",
                              "detail": f"no route {method} {path}"})

    def do_GET(self) -> None:
        self._route()

    def do_POST(self) -> None:
        self._route()

    def do_PUT(self) -> None:
        self._route()

    def do_DELETE(self) -> None:
        self._route()

    def do_PATCH(self) -> None:
        self._route()


def create_server(port: int, state: ServerState) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.state = state  # type: ignore[attr-defined]
    server.daemon_threads = True
    return server


def main() -> int:
    port = int(os.environ.get(PORT_ENV, str(DEFAULT_PORT)))
    jobs_path = Path(os.environ.get(JOBS_PATH_ENV, Path(__file__).parent / "jobs.json"))
    token = os.environ.get(DEFAULT_TOKEN_ENV) or secrets.token_urlsafe(32)
    state = ServerState(token, jobs_path)

    worker = threading.Thread(target=worker_loop, args=(state,), daemon=True)
    worker.start()
    server = create_server(port, state)
    actual_port = server.server_address[1]

    print("=" * 64, flush=True)
    print(f"FLOW SERVER v{VERSION} — listening on 0.0.0.0:{actual_port}", flush=True)
    print("Pairing token (keep secret — the iPhone extension sends it as", flush=True)
    print("the X-Flow-Token header on every request):", flush=True)
    print(f"  {token}", flush=True)
    print("Restart the server to rotate the token (or set FLOW_SERVER_TOKEN).", flush=True)
    print("=" * 64, flush=True)
    log(f"started gflow={'found' if gflow_binary() else 'MISSING'} "
        f"jobs={len(state.jobs)} stopped={state.stopped}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        state.shutdown = True
        with state.cond:
            state.cond.notify_all()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
