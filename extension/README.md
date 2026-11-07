# Flow Capture Observer (Chrome extension)

A small extension that **observes** Google Flow generate requests and logs
them. It is the capture tool for the DevTools plan, without needing DevTools:
it uses `chrome.webRequest` to see each `batchexecute` request Flow fires.

## What it records (per request)

- time, HTTP method, full request URL
- `rpcids` from the URL (for example `ogiZ0b` for image, `eb1hJf` for video,
  `jwpduf` for status polling)
- the `f.req` payload body (the prompt and generation parameters)

## What it never does

- never reads auth headers, cookies or tokens
- never replays a request
- never submits anything on its own
- everything stays in this browser until you download the log

## How to load it (Codespace desktop Chrome)

1. Open Chrome in the Codespace desktop.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this `extension/` folder.
5. Open Flow, generate something, then click the extension icon to see the
   captured requests. **Download log (JSON)** saves them to a file.

## Notes

- Keep the downloaded log local: the payload contains your own prompts and
  project details. Do not paste the raw log anywhere public.
- The log holds at most 500 entries (oldest dropped first). Download it
  before it fills up on a long session.
