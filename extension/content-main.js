// Flow Capture Observer — page hook (MAIN world content script).
// Wraps the Flow page's own fetch() and XMLHttpRequest so batchexecute
// requests are captured even where chrome.webRequest does not fire
// (Orion on iOS). Observation only: it never changes a request, it only
// reads the URL and the body.
//
// IMPORTANT: a MAIN-world script has NO access to chrome.* extension APIs
// (chrome.runtime.sendMessage is undefined here in Chrome, and unreliable
// in Orion). So this file never touches chrome.* — it hands each capture
// to the isolated-world bridge (content-bridge.js) via window.postMessage,
// and the bridge forwards it to the background.
(function () {
  "use strict";
  // Guard against double-injection (Orion may run content scripts twice).
  if (window.__flowCaptureHookInstalled) return;
  window.__flowCaptureHookInstalled = true;

  const MAX_BODY_CHARS = 200000;
  const MARKER = "__flowCaptureObserver";

  function rpcidsFromUrl(url) {
    try {
      const ids = new URL(url, location.href).searchParams.get("rpcids");
      return ids ? ids.split(",") : [];
    } catch (e) {
      return [];
    }
  }

  function frepFromBody(body) {
    try {
      if (body == null) return "";
      if (typeof body === "string") {
        const m = body.match(/(?:^|&)f\.req=([^&]*)/);
        if (m) {
          try {
            return decodeURIComponent(m[1].replace(/\+/g, " ")).slice(0, MAX_BODY_CHARS);
          } catch (e) {
            return m[1].slice(0, MAX_BODY_CHARS);
          }
        }
        return body.slice(0, MAX_BODY_CHARS);
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const v = body.get("f.req");
        return v != null ? String(v).slice(0, MAX_BODY_CHARS) : "";
      }
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        const v = body.get("f.req");
        return v != null ? v.slice(0, MAX_BODY_CHARS) : body.toString().slice(0, MAX_BODY_CHARS);
      }
      return "";
    } catch (e) {
      return "";
    }
  }

  function send(entry) {
    try {
      window.postMessage({ [MARKER]: true, kind: "pageRequest", entry }, location.origin);
    } catch (e) {
      // Never break the page.
    }
  }

  function capture(url, method, body) {
    try {
      if (typeof url !== "string" || !url.includes("batchexecute")) return;
      send({
        time: new Date().toISOString(),
        method: method || "",
        url,
        rpcids: rpcidsFromUrl(url),
        frep: frepFromBody(body),
      });
    } catch (e) {
      // Never break the page.
    }
  }

  // Tell the bridge the hook is installed.
  try {
    window.postMessage({ [MARKER]: true, kind: "pageHookReady" }, location.origin);
  } catch (e) {}

  // Hook fetch.
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          const method = (init && init.method) || (input && input.method) || "GET";
          let body = init && init.body !== undefined ? init.body : undefined;
          if (body === undefined && input && typeof Request !== "undefined" && input instanceof Request) {
            // A Request object carries its body internally; clone+read it
            // without consuming the original.
            try {
              input.clone().text().then((t) => capture(url, method, t)).catch(() => {});
              body = null; // capture happens async above
            } catch (e) {}
          }
          if (body !== null) capture(url, method, body);
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
    }
  } catch (e) {}

  // Hook XMLHttpRequest.
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__flowMethod = method;
        this.__flowUrl = String(url);
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        capture(this.__flowUrl || "", this.__flowMethod || "", body);
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  } catch (e) {}
})();
