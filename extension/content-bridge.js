// Flow Capture Observer — bridge (ISOLATED world content script).
// The MAIN-world hook (content-main.js) cannot call chrome.* APIs, so it
// posts window messages; this script — which does have chrome.runtime —
// listens for them and forwards them to the background. Messages are only
// accepted from this same window and only with our marker, so page scripts
// cannot forge captures.
(function () {
  "use strict";
  const MARKER = "__flowCaptureObserver";

  function forward(msg) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(msg, () => {
          void chrome.runtime.lastError; // background asleep/gone: drop quietly
        });
      }
    } catch (e) {
      // Never break the page.
    }
  }

  window.addEventListener("message", (ev) => {
    try {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d[MARKER] !== true) return;
      if (d.kind === "pageRequest" && d.entry) {
        forward({ type: "pageRequest", entry: d.entry });
      } else if (d.kind === "pageHookReady") {
        forward({ type: "pageHookReady" });
      }
    } catch (e) {}
  });
})();
