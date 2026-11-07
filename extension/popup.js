function render(entries) {
  const list = document.getElementById("list");
  const count = document.getElementById("count");
  count.textContent = entries.length + " batchexecute request(s) captured.";
  list.innerHTML = "";
  entries.slice().reverse().forEach((e) => {
    const div = document.createElement("div");
    div.className = "entry";
    const rpcids = document.createElement("div");
    rpcids.className = "rpcids";
    rpcids.textContent = (e.rpcids && e.rpcids.length ? e.rpcids.join(", ") : "(no rpcid)") + "  " + e.method;
    const time = document.createElement("div");
    time.className = "time";
    time.textContent = e.time;
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = e.url;
    div.appendChild(rpcids);
    div.appendChild(time);
    div.appendChild(url);
    list.appendChild(div);
  });
}

function load() {
  chrome.runtime.sendMessage({ type: "getLog" }, (res) => {
    render((res && res.entries) || []);
  });
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

load();
