# Flow server (Codespace)

HTTP front-end for `gflow` (Google Flow CLI) so an iPhone extension can queue
generations on a Codespace that drives flow.google.com in headed real Chrome.
Stdlib only — no pip installs. The server never talks to flow.google.com
itself and never replays batchexecute requests or scripted clicks; it only
shells out to `gflow` (one subprocess per job, so a crashed generation can't
kill the server).

## Run

```bash
# in the Codespace, from the repo root (gflow installed: pip install --user -e .)
cd server
./start.sh            # or: python3 server.py
```

`start.sh` checks `gflow` is on PATH, warns if `DISPLAY` is unset (headed
Chrome needs it; the `.devcontainer` sets `DISPLAY=:1`), then execs
`python3 server.py`.

On startup the server prints a **pairing token** banner to stdout. The token
is generated with `secrets.token_urlsafe(32)` and is never written to any
file. The iPhone extension sends it as the `X-Flow-Token` header on every
request. Restart to rotate it.

## Env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `FLOW_PORT` | `8766` | Port to bind (0.0.0.0). |
| `FLOW_SERVER_TOKEN` | *(random per start)* | Fixed pairing token, e.g. to survive restarts. |
| `GFLOW_CLI_HOME` | *(gflow default)* | Passed through to `gflow` unchanged; profiles live here. |
| `FLOW_JOBS_PATH` | `server/jobs.json` | Job store location. Test hook only — leave unset in production. |

## API

Every route requires header `X-Flow-Token: <token>` (constant-time compare).
Missing/wrong token → `401 {"error":"unauthorized",...}`. Unknown route →
`404 {"error":"not_found",...}`. All responses are JSON.

| Route | Description |
| --- | --- |
| `GET /health` | `{ok, version:"1.0.0", gflow:bool, stopped:bool, queue:{running:<id\|null>, queued:<n>}}` |
| `GET /accounts` | `[{name, google_account, session:"present"\|"missing", is_default}]` from `gflow auth list --json`. `503` if gflow is missing. |
| `POST /jobs` | Create a job → `201 {id, status:"queued"}`. See below. `503 {"error":"stopped",...}` when the server stopped after an unusual-activity block. |
| `GET /jobs` | All jobs, newest first. |
| `GET /jobs/:id` | One job, or `404`. |

### POST /jobs

```json
{
  "profile": "default",
  "kind": "image",
  "prompt": "a lighthouse at dusk",
  "model": "nano2",
  "aspect": "9:16",
  "count": 1,
  "duration": 8
}
```

- `kind`: `"image"` (default) or `"video"`. Default kind is image; video is
  expensive, use it deliberately.
- `prompt`: required, non-empty, max 2000 chars.
- `profile`: must exist in `GET /accounts` (else `404 unknown_profile`).
  May be omitted only when exactly one profile exists or one is the default.
- Image: `model` in `nano2, nano21, nano2.1, nano-2.1, nano-pro, nano2-lite,
  image4, imagen4` (default `nano2`); `aspect` in `9:16, 16:9, 1:1, 4:3, 3:4`
  (default `9:16`); `count` 1–4 (default 1). `duration` is rejected for images.
- Video: `model` in `omni-flash, veo-lite, veo-fast, veo-quality, veo-lite-lp`
  (default `veo-lite`); `aspect` in `9:16, 16:9` only (default `9:16`);
  `duration` in `4, 6, 8, 10` (default `8`); `count` 1–4 (default 1).
- Validation failures → `400` with `{"error":"invalid_*", "detail":...}`.

Allowlists were verified against `gflow --help` (0.93.0). If gflow adds a
model, update the sets in `server.py` — the server rejects anything else.

### Job record

```json
{
  "id": "a1b2c3d4e5f6", "kind": "image", "prompt": "...",
  "model": "nano2", "aspect": "9:16", "count": 1, "duration": null,
  "profile": "default",
  "status": "queued|running|done|failed|blocked",
  "created_at": "...", "started_at": "...", "finished_at": "...",
  "error": "...", "error_code": "unusual_activity|profile_busy|auth_expired|timeout|gflow_error|server_restarted",
  "results": {"media": [{"url": "...", "local_path": "...", "kind": "image"}]},
  "log_tail": "...last ~4000 chars of gflow output..."
}
```

- Video results have no CDN URL (gflow's video JSON carries only
  `local_path`); their media entry has `"url": null` and a `local_path`.
- Image results carry `fife_url` as `url` plus the downloaded `local_path`.
- If gflow's `--json` shape changes, the server falls back to
  regex-extracting `http(s)` URLs from stdout.

### Failure behaviour

- **unusual-activity** markers (`unusual_activity`, `unusual activity`,
  `extension_hijack_detected`, `WAF 403`) → job `blocked`,
  `error_code: unusual_activity`, and the server sets `stopped=true`:
  every later `POST /jobs` gets `503 {"error":"stopped"}` until restart.
  Never auto-retried.
- **Exit 11 / ProfileLocked** → `failed`, `profile_busy` (profile already
  generating; gflow enforces the per-profile lease).
- **Auth expired** → `failed`, `auth_expired`; the job's `error` tells the
  user to run `gflow auth login --profile <name>` in the Codespace terminal.
- **Timeout** → image 10 min, video 30 min; killed, `failed`, `timeout`.
- Anything else non-zero → `failed`, `gflow_error`, with `log_tail`.

## Queue & persistence

FIFO, one job at a time (worker thread). Jobs persist to `jobs.json` next to
`server.py` via atomic tmp-file + rename; it never stores tokens or
passwords. On startup, jobs left `running` are marked `failed` with
`error_code: server_restarted`.

## Tests

`test_server.py` uses stdlib `unittest` only and never calls real gflow or
Flow. It puts a fake `gflow` executable (a small Python stub) on a temp
`PATH` that answers `auth list --json` with 2 canned profiles and `image t2i`
/ `video t2v --json` with canned output (including one stub that prints an
unusual-activity error and exits non-zero), then starts the real server
in-process on an ephemeral port with `FLOW_SERVER_TOKEN=test-token`.

```bash
cd server
python3 -m unittest test_server.py -v
python3 -m py_compile server.py
bash -n start.sh
```
