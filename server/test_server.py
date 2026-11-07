"""Tests for server.py — stdlib unittest only.

Never calls real gflow or flow.google.com: a fake `gflow` executable (a
small Python stub) is put on a temp PATH. It answers `auth list --json`
with 2 canned profiles and `image t2i` / `video t2v --json` with canned
output, including one path that prints an unusual-activity error and exits
non-zero. The real server is started in-process on an ephemeral port with
FLOW_SERVER_TOKEN=test-token.

Run from this directory:
    python3 -m unittest test_server.py -v
"""

import json
import os
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import server as srv  # noqa: E402

TOKEN = "test-token"

FAKE_GFLOW = '''#!/usr/bin/env python3
"""Fake gflow for tests — canned answers, no network, no Chrome."""
import json
import sys


def main():
    args = sys.argv[1:]
    if args[:2] == ["auth", "list"] and "--json" in args:
        print(json.dumps([
            {"name": "default", "google_account": "unknowjason20@gmail.com",
             "is_default": True, "cookies_present": True,
             "last_used_at": None, "profile_dir": "/tmp/p_default"},
            {"name": "second", "google_account": "other@example.com",
             "is_default": False, "cookies_present": False,
             "last_used_at": None, "profile_dir": "/tmp/p_second"},
        ]))
        return 0
    if args[:2] == ["image", "t2i"]:
        prompt = args[2] if len(args) > 2 else ""
        if "UNUSUAL" in prompt.upper():
            print("Error: PUBLIC_ERROR_UNUSUAL_ACTIVITY — unusual activity "
                  "detected", file=sys.stderr)
            return 1
        n = 1
        if "-n" in args:
            n = int(args[args.index("-n") + 1])
        print(json.dumps({
            "status": "ok", "command": "image t2i", "model": "nano2",
            "count": n,
            "images": [
                {"media_name": f"img-{i}", "fife_url":
                 f"https://example.com/img{i}.png",
                 "local_path": f"/tmp/out/img{i}.png"}
                for i in range(n)
            ],
        }))
        return 0
    if args[:2] == ["video", "t2v"]:
        print(json.dumps({
            "status": "ok", "command": "video t2v", "media_id": "vid-1",
            "generation_status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
            "succeeded": True,
            "local_path": "/tmp/out/vid1.mp4",
            "failure_reasons": [], "error_message": None,
        }))
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)
        # Fake gflow on PATH.
        bindir = self.tmpdir / "bin"
        bindir.mkdir()
        stub = bindir / "gflow"
        stub.write_text(FAKE_GFLOW, encoding="utf-8")
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self._old_path = os.environ.get("PATH", "")
        os.environ["PATH"] = str(bindir) + os.pathsep + self._old_path
        self.jobs_path = self.tmpdir / "jobs.json"
        self.httpd = None
        self._start_server()

    def _start_server(self):
        self.state = srv.ServerState(TOKEN, self.jobs_path)
        self.httpd = srv.create_server(0, self.state)
        self.port = self.httpd.server_address[1]
        self.serve_thread = threading.Thread(
            target=self.httpd.serve_forever, daemon=True)
        self.serve_thread.start()
        self.worker_thread = threading.Thread(
            target=srv.worker_loop, args=(self.state,), daemon=True)
        self.worker_thread.start()

    def _stop_server(self):
        if self.httpd is not None:
            self.state.shutdown = True
            with self.state.cond:
                self.state.cond.notify_all()
            self.httpd.shutdown()
            self.httpd.server_close()
            self.serve_thread.join(timeout=5)
            self.worker_thread.join(timeout=5)
            self.httpd = None

    def tearDown(self):
        self._stop_server()
        os.environ["PATH"] = self._old_path
        self.tmp.cleanup()

    # -- http helper ------------------------------------------------------
    def request(self, method, path, body=None, token=TOKEN):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if token is not None:
            req.add_header("X-Flow-Token", token)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                return exc.code, json.loads(raw or b"null")
            except json.JSONDecodeError:
                return exc.code, {"raw": raw.decode("utf-8", "replace")}

    def wait_for_job(self, job_id, timeout=15.0):
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            status, job = self.request("GET", f"/jobs/{job_id}")
            self.assertEqual(status, 200, job)
            if job["status"] in ("done", "failed", "blocked"):
                return job
            time.sleep(0.1)
        self.fail(f"job {job_id} did not finish within {timeout}s: {job}")

    # -- tests ------------------------------------------------------------
    def test_health(self):
        status, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["version"], "1.0.0")
        self.assertTrue(body["gflow"])
        self.assertFalse(body["stopped"])
        self.assertEqual(body["queue"], {"running": None, "queued": 0})

    def test_auth_missing_token_401(self):
        status, body = self.request("GET", "/health", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "unauthorized")

    def test_auth_wrong_token_401(self):
        status, body = self.request("GET", "/health", token="nope")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "unauthorized")

    def test_accounts_list(self):
        status, body = self.request("GET", "/accounts")
        self.assertEqual(status, 200)
        self.assertEqual(len(body), 2)
        by_name = {a["name"]: a for a in body}
        self.assertEqual(by_name["default"]["google_account"],
                         "unknowjason20@gmail.com")
        self.assertEqual(by_name["default"]["session"], "present")
        self.assertTrue(by_name["default"]["is_default"])
        self.assertEqual(by_name["second"]["session"], "missing")
        self.assertFalse(by_name["second"]["is_default"])

    def test_create_job_201_and_runs_to_done_with_media(self):
        status, body = self.request("POST", "/jobs", {
            "profile": "default", "kind": "image",
            "prompt": "a lighthouse at dusk", "model": "nano2",
            "aspect": "9:16", "count": 2,
        })
        self.assertEqual(status, 201, body)
        self.assertEqual(body["status"], "queued")
        job = self.wait_for_job(body["id"])
        self.assertEqual(job["status"], "done")
        self.assertEqual(len(job["results"]["media"]), 2)
        self.assertEqual(job["results"]["media"][0]["url"],
                         "https://example.com/img0.png")
        self.assertEqual(job["results"]["media"][0]["local_path"],
                         "/tmp/out/img0.png")
        self.assertEqual(job["results"]["media"][0]["kind"], "image")
        self.assertIsNotNone(job["started_at"])
        self.assertIsNotNone(job["finished_at"])

    def test_create_job_validation_400(self):
        bad_bodies = [
            {"profile": "default", "kind": "image", "prompt": ""},
            {"profile": "default", "kind": "image", "prompt": "x" * 2001},
            {"profile": "default", "kind": "image", "prompt": "ok",
             "model": "veo-lite"},                       # video model, image job
            {"profile": "default", "kind": "image", "prompt": "ok",
             "aspect": "2:1"},
            {"profile": "default", "kind": "image", "prompt": "ok",
             "count": 5},
            {"profile": "default", "kind": "image", "prompt": "ok",
             "duration": 8},                             # duration is video-only
            {"profile": "default", "kind": "video", "prompt": "ok",
             "aspect": "1:1"},                           # video: 9:16/16:9 only
            {"profile": "default", "kind": "video", "prompt": "ok",
             "duration": 5},
            {"profile": "default", "kind": "song", "prompt": "ok"},
        ]
        for bad in bad_bodies:
            status, body = self.request("POST", "/jobs", bad)
            self.assertEqual(status, 400, (bad, body))
            self.assertIn("error", body)

    def test_create_job_unknown_profile_404(self):
        status, body = self.request("POST", "/jobs", {
            "profile": "ghost", "kind": "image", "prompt": "hi",
        })
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "unknown_profile")

    def test_video_job_done(self):
        status, body = self.request("POST", "/jobs", {
            "profile": "second", "kind": "video",
            "prompt": "waves at sunset", "model": "veo-lite",
            "aspect": "16:9", "duration": 8, "count": 1,
        })
        self.assertEqual(status, 201, body)
        job = self.wait_for_job(body["id"])
        self.assertEqual(job["status"], "done")
        self.assertEqual(len(job["results"]["media"]), 1)
        self.assertEqual(job["results"]["media"][0]["kind"], "video")
        self.assertEqual(job["results"]["media"][0]["local_path"],
                         "/tmp/out/vid1.mp4")

    def test_unusual_activity_blocks_and_stops_server(self):
        status, body = self.request("POST", "/jobs", {
            "profile": "default", "kind": "image",
            "prompt": "UNUSUAL trigger please",
        })
        self.assertEqual(status, 201, body)
        job = self.wait_for_job(body["id"])
        self.assertEqual(job["status"], "blocked")
        self.assertEqual(job["error_code"], "unusual_activity")
        status, health = self.request("GET", "/health")
        self.assertTrue(health["stopped"])
        status, body = self.request("POST", "/jobs", {
            "profile": "default", "kind": "image", "prompt": "another",
        })
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "stopped")

    def test_get_job_by_id_and_unknown_404(self):
        status, body = self.request("POST", "/jobs", {
            "profile": "default", "kind": "image", "prompt": "a cat",
        })
        job_id = body["id"]
        status, job = self.request("GET", f"/jobs/{job_id}")
        self.assertEqual(status, 200)
        self.assertEqual(job["id"], job_id)
        status, body = self.request("GET", "/jobs/doesnotexist")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "not_found")

    def test_jobs_list_newest_first(self):
        ids = []
        for prompt in ("first job", "second job"):
            _, body = self.request("POST", "/jobs", {
                "profile": "default", "kind": "image", "prompt": prompt,
            })
            ids.append(body["id"])
            self.wait_for_job(body["id"])
        status, jobs = self.request("GET", "/jobs")
        self.assertEqual(status, 200)
        self.assertEqual([j["id"] for j in jobs], [ids[1], ids[0]])

    def test_unknown_route_404(self):
        status, body = self.request("GET", "/nope")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "not_found")

    def test_persistence_round_trip_and_restart_marks_running_failed(self):
        _, body = self.request("POST", "/jobs", {
            "profile": "default", "kind": "image", "prompt": "persist me",
        })
        job_id = body["id"]
        self.wait_for_job(job_id)
        # jobs.json on disk holds the finished job.
        stored = json.loads(self.jobs_path.read_text())
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["id"], job_id)
        self.assertEqual(stored[0]["status"], "done")
        self.assertNotIn("test-token", self.jobs_path.read_text())
        # Simulate a crash: append a job left "running", restart the server.
        self._stop_server()
        stored.append({
            "id": "crashedjob01", "kind": "image", "prompt": "crashed",
            "model": "nano2", "aspect": "9:16", "count": 1, "duration": None,
            "profile": "default", "status": "running",
            "created_at": "2026-11-07T00:00:00Z",
            "started_at": "2026-11-07T00:01:00Z", "finished_at": None,
        })
        self.jobs_path.write_text(json.dumps(stored))
        self._start_server()
        status, jobs = self.request("GET", "/jobs")
        self.assertEqual(status, 200)
        by_id = {j["id"]: j for j in jobs}
        self.assertEqual(by_id[job_id]["status"], "done")
        self.assertEqual(by_id["crashedjob01"]["status"], "failed")
        self.assertEqual(by_id["crashedjob01"]["error_code"],
                         "server_restarted")


if __name__ == "__main__":
    unittest.main()
