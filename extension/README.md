# Flow Capture Observer (Chrome extension) — v1.3.0 (Orion build)

A small extension that **observes** Google Flow generate requests and logs
them. It is the capture tool for the DevTools plan, without needing DevTools.

## What it records (per request)

- time, HTTP method, full request URL
- `rpcids` from the URL (for example `ogiZ0b` for image, `eb1hJf` for video,
  `jwpduf` for status polling)
- the `f.req` payload body (the prompt and generation parameters)

## What it never does

- never reads auth headers, cookies or tokens
- never replays a request
- never submits anything on its own
- everything stays in this browser until you download or copy the log

## How it captures (page hook only)

A MAIN-world content script (`content-main.js`) wraps the Flow page's own
`fetch` and `XMLHttpRequest` and forwards each `batchexecute` call to the
background. A MAIN-world script cannot call `chrome.*` APIs, so it hands
each capture to an isolated-world bridge (`content-bridge.js`) via
`window.postMessage`, and the bridge forwards it to the background. It
only sees requests the page's own JavaScript makes.

**There is no `webRequest` permission and no webRequest code in this
version.** Orion on iOS only partially supports webRequest, and merely
declaring the permission triggers Orion's "Extension Compatibility Issue"
warning at install. Removing it makes the extension install cleanly on
Orion. (Desktop Chrome capture via webRequest lives in the v1.2.0 build in
git history.)

## What changed in v1.3.0

- **Removed:** the `webRequest` permission and listener — no more
  "Extension Compatibility Issue" warning on Orion, and nothing left for
  Orion to warn about.
- **Added:** an in-page panel. On `flow.google.com` a floating button
  **"📋 Flow Log (n)"** appears at the bottom-right. Tap it to see the
  captured requests, with **Copy** and **Download** buttons — no need to
  open the extension popup at all (Orion on iOS does not always show it).
  The panel also pulls the background's saved log, so entries from before
  a page reload show up too.
- The extension popup still exists (same log, same buttons) for browsers
  that show it.

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

## How to install it (Orion on iOS)

The ZIP must have `manifest.json` at its root (this one does — do not
re-zip it inside another folder).

1. Uninstall the old copy first (⋯ → Extensions → swipe the old
   "Flow Capture Observer" → Uninstall).
2. Save the ZIP in the Files app on **On My iPhone** local storage
   (not iCloud Drive).
3. In Orion: `⋯` → **Settings → Extensions** → turn **Chrome extensions ON**.
4. `⋯` → **Extensions** → **+** → **Install from File** → pick the ZIP.
   If the picker will not show the ZIP, unzip it in Files, move the folder
   into **On My iPhone → Orion → Extensions**, then pick the folder itself.
5. Enable the extension and allow it site access on `flow.google.com`.
6. Open Flow and generate something. A **"📋 Flow Log"** button appears
   at the bottom-right of the page — tap it to see the captures. If the
   button does not appear, the content script did not run (check the
   extension is enabled and has site access).

## How to load it (desktop Chrome)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this extension folder.
4. Open Flow, generate something, then tap the floating **"📋 Flow Log"**
   button on the page (or the extension icon) to see the captured requests.

## Notes

- Keep the downloaded log local: the payload contains your own prompts and
  project details. Do not paste the raw log anywhere public.
- The log holds at most 500 entries (oldest dropped first). Download or copy
  it before it fills up on a long session.
- Sideloaded extensions never auto-update: uninstall the old copy first,
  then install the new ZIP.
