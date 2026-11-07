function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

function render(entries) {
  const list = document.getElementById("list");
  const count = document.getElementById("count");
  count.textContent = entries.length + " batchexecute request(s) captured.";
  list.innerHTML = "";
  entries.slice().reverse().forEach((e) => {
    const div = el("div", "entry");
    const src = e.source === "page-hook" ? "[page hook] " : e.source === "webrequest" ? "[webRequest] " : "";
    div.appendChild(el("div", "rpcids", src + (e.rpcids && e.rpcids.length ? e.rpcids.join(", ") : "(no rpcid)") + "  " + (e.method || "")));
    div.appendChild(el("div", "time", e.time || ""));
    div.appendChild(el("div", "url", e.url || ""));
    list.appendChild(div);
  });
}

function loadFromStorage() {
  try {
    chrome.storage.local.get({ flowCaptureLog: [] }, (res) => {
      render((res && res.flowCaptureLog) || []);
    });
  } catch (e) {
    render([]);
  }
}

function load() {
  const statusEl = document.getElementById("status");
  try {
    chrome.runtime.sendMessage({ type: "getStatus" }, (st) => {
      if (chrome.runtime.lastError || !st) {
        statusEl.textContent = "Background unreachable — showing saved log.";
        loadFromStorage();
        return;
      }
      statusEl.textContent =
        "webRequest: " + (st.webRequest ? "on" : "off") +
        "  •  page hook: " + (st.pageHook ? "active" : "not seen yet") +
        "  •  " + (st.count || 0) + " in memory";
      chrome.runtime.sendMessage({ type: "getLog" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          loadFromStorage();
          return;
        }
        render((res && res.entries) || []);
      });
    });
  } catch (e) {
    loadFromStorage();
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (e) {}
  ta.remove();
  document.getElementById("count").textContent = "Copy attempted — paste to check.";
}

document.getElementById("refresh").addEventListener("click", load);

document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clearLog" }, load);
});

document.getElementById("download").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "getLog" }, (res) => {
    const entries = (res && res.entries) || [];
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "flow-capture-log.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
});

document.getElementById("copy").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "getLog" }, (res) => {
    const entries = (res && res.entries) || [];
    const text = JSON.stringify(entries, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        document.getElementById("count").textContent = "Copied " + entries.length + " entries to clipboard.";
      }).catch(() => {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  });
});

load();
