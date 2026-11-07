# Flow Capture Observer (Chrome extension) — v1.2.0

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
   Flow page's own `fetch` and `XMLHttpRequest`. A MAIN-world script cannot
   call `chrome.*` APIs, so it hands each capture to an isolated-world
   bridge (`content-bridge.js`) via `window.postMessage`, and the bridge
   forwards it to the background. This is the working path on Orion for iOS,
   where webRequest is unreliable. It only sees requests the page's own
   JavaScript makes.

The background de-duplicates: if both paths see the same request, it is
logged once. The popup shows which path is active: `webRequest: on/off` and
`page hook: active/not seen yet`.

## What changed in v1.2.0

- **Fixed:** the page hook called `chrome.runtime.sendMessage` from the MAIN
  world, where extension APIs do not exist — captures were silently dropped.
  It now goes through the `content-bridge.js` postMessage bridge.
- **Fixed:** `fetch(new Request(...))` calls carried no readable body; the
  hook now clones the Request and reads its body without consuming it.
- **Fixed:** double-logging when webRequest and the page hook both fire.
- **Fixed:** popup Download/Copy/Clear broke silently when the background
  was asleep; they now fall back to the saved log in `chrome.storage.local`.
- **Added:** double-injection guard in the page hook, extension icons.

## How to load it (desktop Chrome)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this extension folder.
4. Open Flow, generate something, then click the extension icon to see the
   captured requests. **Download log (JSON)** or **Copy log** saves them.

## How to install it (Orion on iOS)

The ZIP must have `manifest.json` at its root (this one does — do not
re-zip it inside another folder).

1. Save the ZIP in the Files app on **On My iPhone** local storage
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
