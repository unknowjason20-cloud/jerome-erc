# Flow Remote (v1.0.0)

Remote control for your own Google Flow server running in a GitHub Codespace. You tap here on your iPhone; the server does the clicking in headed Chrome in the Codespace and sends the results back.

## What this extension IS

- A UI + API client for **your** Codespace server (`https://<name>-8766.app.github.dev`).
- It sends jobs (prompt, model, aspect, count/duration) to the server and shows their status and result links.

## What it is NOT

- It never touches `flow.google.com` directly and never submits anything to Flow itself.
- It never automates anything in this browser — there is no auto-click, no auto-retry, no auto-resubmit.
- It never stores any Google session. Sessions live in Chrome profiles on the Codespace server, never in the extension.
- It never asks for your Google password. **Never paste your Google password here.**

## Install (Orion on iOS)

1. Get the ZIP (`flow-remote-v1.0.0.zip`) — the `manifest.json` is at the ZIP root.
2. Save it to **On My iPhone** (local storage, not iCloud Drive).
3. In Orion: `⋯ → Extensions → + → Install from File`, pick the ZIP.
4. Tap the Flow Remote icon to open the popup.

## Setup

1. In the Codespace terminal, start the server and copy the pairing token it prints.
2. Open the popup → **Settings** → paste the **Server URL** (e.g. `https://<name>-8766.app.github.dev`, no trailing slash) and the **Pairing token** → **Save** → **Test connection**.
3. Pick an **Account**. If it says "session missing", run this in the Codespace terminal first (the extension cannot log anyone in):
   ```
   gflow auth login --profile <name>
   ```
4. Write a prompt, pick image/video + model, tap **Send job**. Results appear under **Jobs** — Open, Copy URL, or Download (download is best-effort on Orion iOS; Copy URL always works).

## What the errors mean

| Message | What to do |
|---|---|
| Wrong or expired pairing token (401) | Re-copy the token from the Codespace terminal and paste it in Settings. |
| Server stopped / unusual-activity stop (503) | **Stop sending jobs.** Restart the server in the Codespace. |
| Cannot reach the server | Check the URL and that the Codespace is still running (Codespaces sleep when idle). |
| Session missing | Run `gflow auth login --profile <name>` in the Codespace terminal. |
| Job status **blocked** | Flow flagged unusual activity on that job. Do **not** resend it. Stop and restart the server. |

## Notes

- Jobs auto-refresh every 5 seconds only while the popup is open.
- Image default: Nano Banana 2 (cheapest), 9:16, count 1. Video default: Veo Lite, 8s. 10s is only offered for Omni Flash.
- Untested on a real iPhone — please report what you see on Orion.
