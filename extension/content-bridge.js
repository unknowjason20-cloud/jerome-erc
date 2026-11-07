// Flow Capture Observer — bridge (ISOLATED world content script).
// The MAIN-world hook (content-main.js) cannot call chrome.* APIs, so it
// posts window messages; this script — which does have chrome.runtime —
// listens for them and forwards them to the background. Messages are only
// accepted from this same window and only with our marker, so page scripts
// cannot forge captures.
//
// It also answers the page's getLog requests: the in-page panel asks for
// the background's persisted log, and this script posts the snapshot back.
(function () {
  "use strict";
  const MARKER = "__flowCaptureObserver";

  function forward(msg, done) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError; // background asleep/gone: drop quietly
          if (typeof done === "function") {
            try {
              done(res);
            } catch (e) {}
          }
        });
      }
    } catch (e) {
      // Never break the page.
    }
  }

  function postToPage(msg) {
    try {
      window.postMessage(
        Object.assign({ [MARKER]: true }, msg),
        location.origin
      );
    } catch (e) {}
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
      } else if (d.kind === "getLog") {
        forward({ type: "getLog" }, (res) => {
          postToPage({
            kind: "logSnapshot",
            entries: (res && res.entries) || [],
          });
        });
      }
    } catch (e) {}
  });
})();
