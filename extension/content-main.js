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
//
// v1.3.0: this file also draws its own UI on the Flow page — a floating
// "Flow Log" button (bottom-right) that opens an in-page panel with the
// captured requests, Copy and Download. That way the log is visible even
// when the browser does not show the extension popup (Orion on iOS).
(function () {
  "use strict";
  // Guard against double-injection (Orion may run content scripts twice).
  if (window.__flowCaptureHookInstalled) return;
  window.__flowCaptureHookInstalled = true;

  const MAX_BODY_CHARS = 200000;
  const MAX_PANEL_ENTRIES = 100;
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

  // ---- local copy of this page's captures (for the in-page panel) ----
  const localEntries = [];
  let snapshotEntries = [];
  function entryKey(e) {
    return (e.url || "") + "|" + (e.time || "") + "|" + String(e.frep || "").slice(0, 80);
  }
  function addLocal(entry) {
    try {
      const k = entryKey(entry);
      if (localEntries.some((e) => entryKey(e) === k)) return;
      localEntries.push(entry);
      if (localEntries.length > 500) localEntries.shift();
      updateButton();
    } catch (e) {}
  }
  function mergedEntries() {
    const seen = new Set();
    const out = [];
    for (const e of localEntries.concat(snapshotEntries)) {
      const k = entryKey(e);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(e);
      }
    }
    out.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
    return out;
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
      const entry = {
        time: new Date().toISOString(),
        method: method || "",
        url,
        rpcids: rpcidsFromUrl(url),
        frep: frepFromBody(body),
      };
      send(entry);
      addLocal(entry);
    } catch (e) {
      // Never break the page.
    }
  }

  // Tell the bridge the hook is installed.
  try {
    window.postMessage({ [MARKER]: true, kind: "pageHookReady" }, location.origin);
  } catch (e) {}

  // ---- in-page panel UI (floating button + log panel) ----
  let btn = null;
  let panel = null;
  let listEl = null;
  let countEl = null;

  function h(tag, text, styles) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (styles) {
      for (const k in styles) {
        try {
          el.style[k] = styles[k];
        } catch (e) {}
      }
    }
    return el;
  }

  function updateButton() {
    try {
      if (btn) btn.textContent = "📋 Flow Log (" + localEntries.length + ")";
    } catch (e) {}
  }

  function renderPanel() {
    try {
      if (!listEl) return;
      const entries = mergedEntries();
      if (countEl) countEl.textContent = entries.length + " captured";
      listEl.innerHTML = "";
      entries
        .slice()
        .reverse()
        .slice(0, MAX_PANEL_ENTRIES)
        .forEach((e) => {
          const div = h("div", null, {
            borderTop: "1px solid #ddd",
            padding: "6px 0",
            wordBreak: "break-all",
          });
          div.appendChild(
            h(
              "div",
              (e.rpcids && e.rpcids.length ? e.rpcids.join(", ") : "(no rpcid)") +
                "  " +
                (e.method || ""),
              { fontWeight: "bold", fontSize: "12px" }
            )
          );
          div.appendChild(h("div", e.time || "", { color: "#888", fontSize: "11px" }));
          div.appendChild(h("div", e.url || "", { color: "#555", fontSize: "11px" }));
          listEl.appendChild(div);
        });
    } catch (e) {}
  }

  function requestSnapshot() {
    try {
      window.postMessage({ [MARKER]: true, kind: "getLog" }, location.origin);
    } catch (e) {}
  }

  function togglePanel() {
    try {
      if (!panel) return;
      const open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
      if (open) {
        requestSnapshot();
        renderPanel();
      }
    } catch (e) {}
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch (e) {}
  }

  function copyLog() {
    const text = JSON.stringify(mergedEntries(), null, 2);
    try {
      const nav = typeof navigator !== "undefined" ? navigator : null;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(text).catch(() => fallbackCopy(text));
        return;
      }
    } catch (e) {}
    fallbackCopy(text);
  }

  function downloadLog() {
    try {
      const blob = new Blob([JSON.stringify(mergedEntries(), null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "flow-capture-log.json";
      a.click();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(a.href);
        } catch (e) {}
      }, 5000);
    } catch (e) {}
  }

  function injectPanel() {
    try {
      if (!document.body || btn) return;
      btn = h("button", "📋 Flow Log (0)", {
        position: "fixed",
        right: "12px",
        bottom: "12px",
        zIndex: "2147483647",
        padding: "8px 12px",
        borderRadius: "20px",
        border: "1px solid #888",
        background: "#111",
        color: "#fff",
        fontSize: "13px",
        cursor: "pointer",
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      });
      btn.addEventListener("click", togglePanel);
      panel = h("div", null, {
        position: "fixed",
        right: "12px",
        bottom: "56px",
        width: "360px",
        maxWidth: "92vw",
        maxHeight: "60vh",
        overflowY: "auto",
        zIndex: "2147483647",
        background: "#fff",
        color: "#111",
        border: "1px solid #999",
        borderRadius: "10px",
        padding: "10px",
        fontFamily: "sans-serif",
        fontSize: "13px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        display: "none",
      });
      const head = h("div", null, {
        display: "flex",
        gap: "6px",
        alignItems: "center",
        marginBottom: "6px",
      });
      head.appendChild(h("strong", "Flow Capture Observer", { flex: "1" }));
      countEl = h("span", "0 captured", { color: "#555", fontSize: "12px" });
      head.appendChild(countEl);
      const copyBtn = h("button", "Copy", { padding: "4px 8px", cursor: "pointer" });
      copyBtn.addEventListener("click", copyLog);
      head.appendChild(copyBtn);
      const dlBtn = h("button", "Download", { padding: "4px 8px", cursor: "pointer" });
      dlBtn.addEventListener("click", downloadLog);
      head.appendChild(dlBtn);
      const closeBtn = h("button", "✕", { padding: "4px 8px", cursor: "pointer" });
      closeBtn.addEventListener("click", togglePanel);
      head.appendChild(closeBtn);
      listEl = h("div", null, {});
      panel.appendChild(head);
      panel.appendChild(listEl);
      document.body.appendChild(btn);
      document.body.appendChild(panel);
    } catch (e) {}
  }

  // Snapshots from the bridge (the background's persisted log).
  try {
    window.addEventListener("message", (ev) => {
      try {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d[MARKER] !== true) return;
        if (d.kind === "logSnapshot" && Array.isArray(d.entries)) {
          snapshotEntries = d.entries;
          renderPanel();
        }
      } catch (e) {}
    });
  } catch (e) {}

  // Inject the panel as soon as the body exists.
  try {
    if (document.body) injectPanel();
    else if (document.addEventListener) document.addEventListener("DOMContentLoaded", injectPanel);
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
