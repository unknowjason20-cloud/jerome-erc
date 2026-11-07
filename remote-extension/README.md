# Flow Remote (v1.1.0)

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

1. Get the ZIP (`flow-remote-v1.1.0.zip`) — the `manifest.json` is at the ZIP root.
2. Save it to **On My iPhone** (local storage, not iCloud Drive).
3. In Orion: `⋯ → Extensions → + → Install from File`, pick the ZIP.
4. Uninstall any older Flow Remote copy first (sideloaded extensions never auto-update).

## Use (Orion on iOS) — the in-page panel

The browser-action popup does **not** appear on Orion iOS, so the primary UI is an in-page panel:

1. Open **flow.google.com** in Orion.
2. Tap the floating **⚡ Flow Remote** button at the bottom-right of the page (drag it if it covers something).
3. The panel opens: **Background** health line, server **status**, **Settings**, **Account**, **New job**, **Jobs**.
4. First time only — **Settings** → paste the **Server URL** (e.g. `https://<name>-8766.app.github.dev`, no trailing slash) and the **Pairing token** from the Codespace terminal → **Save** → **Test connection**.
5. Pick an **Account**. If it says "session missing", run this in the Codespace terminal first (the extension cannot log anyone in):
   ```
   gflow auth login --profile <name>
   ```
6. Write a prompt, pick image/video + model, tap **Send job**. Results appear under **Jobs** — Open, Copy URL, or Download (download is best-effort on Orion iOS; Copy URL always works). Jobs auto-refresh every 5 seconds only while the panel is open.

The **Background** line shows `RUNNING` (background alive), `NOT RESPONDING` (it started before but is suspended now — reload the page), or `NEVER STARTED` (the extension did not start — close and reopen Orion).

## Use (desktop Chrome/Firefox) — the popup

On desktop the classic popup still works: tap the Flow Remote toolbar icon. It has the same Settings / Account / New job / Jobs UI as the panel.

## Setup (Codespace server)

1. In the Codespace terminal, start the server and copy the pairing token it prints.
2. Fill in Settings in the panel (or popup) as above.

## What the errors mean

| Message | What to do |
|---|---|
| Wrong or expired pairing token (401) | Re-copy the token from the Codespace terminal and paste it in Settings. |
| Server stopped / unusual-activity stop (503) | **Stop sending jobs.** Restart the server in the Codespace. |
| Cannot reach the server | Check the URL and that the Codespace is still running (Codespaces sleep when idle). |
| Background: NOT RESPONDING / NEVER STARTED | Reload flow.google.com; if it stays, close and reopen Orion. |
| Session missing | Run `gflow auth login --profile <name>` in the Codespace terminal. |
| Job status **blocked** | Flow flagged unusual activity on that job. Do **not** resend it. Stop and restart the server. |

## Notes

- Jobs auto-refresh every 5 seconds only while the panel (or popup) is open.
- Image default: Nano Banana 2 (cheapest), 9:16, count 1. Video default: Veo Lite, 8s. 10s is only offered for Omni Flash.
- Panel state (server URL, token, panel open/closed, last job list) is kept in `chrome.storage.local` only, so a page reload restores it.
- v1.1.0 mock chain test: `node tests/test-panel-chain.js` (panel inject, toggle, settings round-trip, background proxy, blocked-job handling, beacon). Live Orion test still pending — please report what you see.
