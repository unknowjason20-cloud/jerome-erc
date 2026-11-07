# Flow Capture Observer (Chrome extension) — v1.1.0

A small extension that **observes** Google Flow generate requests and logs
them. It is the capture tool for the DevTools plan, without needing DevTools.

## What it records (per request)

- time, HTTP method, full request URL
- `rpcids` from the URL (for example `ogiZ0b` for image, `eb1hJf` for video,
  `jwpduf` for status polling)
- the `f.req` payload body (the prompt and generation parameters)
- `source`: `webrequest` (browser network API) or `page-hook` (in-page
  fetch/XHR hook)

## What it never does

- never reads auth headers, cookies or tokens
- never replays a request
- never submits anything on its own
- everything stays in this browser until you download or copy the log

## How it captures (two paths)

1. **webRequest** — `chrome.webRequest.onBeforeRequest` with `requestBody`.
   This is the primary path on desktop Chrome and Orion for macOS, where the
   API works. The listener is guarded: if the browser does not offer the
   event (Orion on iOS), the background keeps running and the popup says so.
2. **Page hook** — a MAIN-world content script (`content-main.js`) wraps the
   Flow page's own `fetch` and `XMLHttpRequest` and forwards each
   `batchexecute` call to the background. This is the working path on Orion
   for iOS, where webRequest is unreliable. It only sees requests the page's
   own JavaScript makes.

The popup shows which path is active: `webRequest: on/off` and
`page hook: active/not seen yet`.

## How to load it (Codespace desktop Chrome)

1. Open Chrome in the Codespace desktop.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this `extension/` folder.
5. Open Flow, generate something, then click the extension icon to see the
   captured requests. **Download log (JSON)** or **Copy log** saves them.

## How to install it (Orion on iOS)

1. Save the extension ZIP in the Files app on **On My iPhone** local storage
   (not iCloud Drive).
2. In Orion: `⋯` → **Settings → Extensions** → turn **Chrome extensions ON**.
3. `⋯` → **Extensions** → **+** → **Install from File** → pick the ZIP.
   If the picker will not show the ZIP, unzip it in Files, move the folder
   into **On My iPhone → Orion → Extensions**, then pick the folder itself.
4. Enable the extension and allow it site access on `flow.google.com`.
5. Open Flow, generate something, then open the popup. If `page hook`
   says `active`, capture is working. If both paths say off / not seen,
   Orion on iOS is not exposing the needed APIs — test the same build on
   Orion for macOS instead, where webRequest works.

## Notes

- Keep the downloaded log local: the payload contains your own prompts and
  project details. Do not paste the raw log anywhere public.
- The log holds at most 500 entries (oldest dropped first). Download or copy
  it before it fills up on a long session.
- Sideloaded extensions never auto-update: uninstall the old copy first,
  then install the new ZIP.
