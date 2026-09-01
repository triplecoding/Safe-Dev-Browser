const state = {
  history: [],
  historyIndex: -1,
  events: [],
  checks: [],
  config: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const els = {
  status: $("#serverStatus"),
  input: $("#urlInput"),
  preview: $("#preview"),
  frame: $("#previewFrame"),
  open: $("#openButton"),
  reload: $("#reloadButton"),
  back: $("#backButton"),
  forward: $("#forwardButton"),
  check: $("#checkButton"),
  autoRefresh: $("#autoRefresh"),
  fitViewport: $("#fitViewport"),
  zoom: $("#zoomSelect"),
  eventList: $("#eventList"),
  clearEvents: $("#clearEvents"),
  errorCount: $("#errorCount"),
  warnCount: $("#warnCount"),
  networkCount: $("#networkCount"),
  checkList: $("#checkList"),
  checkState: $("#checkState"),
  notes: $("#notes"),
  report: $("#reportOutput"),
  exportReport: $("#exportReport"),
  copyBridge: $("#copyBridge")
};

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function openUrl(url, addHistory = true) {
  const next = normalizeUrl(url);
  if (!next) return;
  els.input.value = next;
  els.preview.src = next;
  localStorage.setItem("dev-browser-safe:last-url", next);
  if (addHistory) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(next);
    state.historyIndex = state.history.length - 1;
    updateNav();
  }
}

function updateNav() {
  els.back.disabled = state.historyIndex <= 0;
  els.forward.disabled = state.historyIndex >= state.history.length - 1;
}

function applyViewport(width, height) {
  const fit = els.fitViewport.checked;
  if (width === "100%") {
    els.frame.style.width = "100%";
    els.frame.style.height = "100%";
    els.frame.style.aspectRatio = "";
  } else {
    els.frame.style.width = `${width}px`;
    els.frame.style.height = `${height}px`;
    els.frame.style.maxWidth = fit ? "100%" : "none";
    els.frame.style.maxHeight = fit ? "100%" : "none";
  }
  els.frame.style.transform = `scale(${els.zoom.value})`;
}

function formatDetail(detail) {
  if (!detail) return "";
  if (detail.args) return detail.args.map(item => typeof item === "string" ? item : JSON.stringify(item)).join(" ");
  return JSON.stringify(detail, null, 2);
}

function eventLevel(event) {
  const level = event.level || event.detail?.level || "";
  if (event.type === "runtime-error" || event.type === "unhandled-rejection" || level === "error") return "error";
  if (level === "warn") return "warn";
  if (event.type === "network") return "network";
  return "info";
}

function renderEvents() {
  const errors = state.events.filter(event => eventLevel(event) === "error").length;
  const warns = state.events.filter(event => eventLevel(event) === "warn").length;
  const network = state.events.filter(event => event.type === "network").length;
  els.errorCount.textContent = errors;
  els.warnCount.textContent = warns;
  els.networkCount.textContent = network;

  els.eventList.innerHTML = "";
  for (const event of state.events.slice(-80).reverse()) {
    const level = eventLevel(event);
    const item = document.createElement("article");
    item.className = `event ${level}`;
    item.innerHTML = `
      <div class="event-title">
        <span>${event.type || "event"}</span>
        <time>${new Date(event.receivedAt || event.time || Date.now()).toLocaleTimeString()}</time>
      </div>
      <pre>${escapeHtml(formatDetail(event.detail))}</pre>
    `;
    els.eventList.append(item);
  }
}

function renderChecks() {
  els.checkList.innerHTML = "";
  if (!state.checks.length) {
    els.checkList.innerHTML = `<p class="muted">Run checks against the current preview URL to see response, title, and basic accessibility signals.</p>`;
    return;
  }
  for (const check of state.checks) {
    const item = document.createElement("article");
    item.className = `check ${check.pass ? "pass" : "fail"}`;
    item.innerHTML = `
      <div class="check-title">
        <span>${escapeHtml(check.name)}</span>
        <strong>${check.pass ? "Pass" : "Fix"}</strong>
      </div>
      <p>${escapeHtml(check.detail || "")}</p>
    `;
    els.checkList.append(item);
  }
}

function buildReport() {
  const errors = state.events.filter(event => eventLevel(event) === "error");
  const warnings = state.events.filter(event => eventLevel(event) === "warn");
  const failedChecks = state.checks.filter(check => !check.pass);
  return [
    "# Dev Browser Safe Report",
    "",
    `Target: ${els.input.value}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    `Errors: ${errors.length}`,
    `Warnings: ${warnings.length}`,
    `Network events: ${state.events.filter(event => event.type === "network").length}`,
    `Failed checks: ${failedChecks.length}`,
    "",
    "## Failed Checks",
    failedChecks.length ? failedChecks.map(check => `- ${check.name}: ${check.detail}`).join("\n") : "- None",
    "",
    "## Notes",
    els.notes.value.trim() || "No notes added."
  ].join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function runChecks() {
  els.check.disabled = true;
  els.checkState.textContent = "Running...";
  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: els.input.value })
    });
    const result = await response.json();
    state.checks = result.checks || [{ name: "Check failed", pass: false, detail: result.error || "Unknown failure" }];
    els.checkState.textContent = result.ok ? "Passed" : "Needs attention";
    renderChecks();
  } catch (error) {
    state.checks = [{ name: "Check failed", pass: false, detail: error.message }];
    els.checkState.textContent = "Failed";
    renderChecks();
  } finally {
    els.check.disabled = false;
  }
}

function connectEvents() {
  const stream = new EventSource("/api/events");
  stream.onopen = () => {
    els.status.textContent = state.config?.allowRemote ? "Ready, remote checks allowed" : "Ready, local-safe mode";
    els.status.classList.add("ready");
  };
  stream.onmessage = message => {
    const event = JSON.parse(message.data);
    state.events.push(event);
    if (state.events.length > 500) state.events.shift();
    renderEvents();
  };
  stream.onerror = () => {
    els.status.textContent = "Reconnecting...";
    els.status.classList.remove("ready");
  };
}

async function boot() {
  const lastUrl = localStorage.getItem("dev-browser-safe:last-url") || els.input.value;
  const notes = localStorage.getItem("dev-browser-safe:notes") || "";
  els.notes.value = notes;
  try {
    state.config = await fetch("/api/config").then(response => response.json());
  } catch {
    state.config = { allowRemote: false };
  }
  openUrl(lastUrl);
  connectEvents();
  renderEvents();
  renderChecks();
}

els.open.addEventListener("click", () => openUrl(els.input.value));
els.input.addEventListener("keydown", event => {
  if (event.key === "Enter") openUrl(els.input.value);
});
els.reload.addEventListener("click", () => {
  const url = els.preview.src;
  els.preview.src = "about:blank";
  setTimeout(() => { els.preview.src = url; }, 30);
});
els.back.addEventListener("click", () => {
  if (state.historyIndex > 0) {
    state.historyIndex -= 1;
    openUrl(state.history[state.historyIndex], false);
    updateNav();
  }
});
els.forward.addEventListener("click", () => {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex += 1;
    openUrl(state.history[state.historyIndex], false);
    updateNav();
  }
});
els.check.addEventListener("click", runChecks);
els.clearEvents.addEventListener("click", () => {
  state.events = [];
  renderEvents();
});
els.notes.addEventListener("input", () => localStorage.setItem("dev-browser-safe:notes", els.notes.value));
els.exportReport.addEventListener("click", () => {
  const report = buildReport();
  els.report.textContent = report;
  const blob = new Blob([report], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "dev-browser-safe-report.md";
  a.click();
  URL.revokeObjectURL(url);
});
els.copyBridge.addEventListener("click", async () => {
  await navigator.clipboard.writeText('<script src="http://127.0.0.1:4577/agent-bridge.js"></script>');
  els.copyBridge.textContent = "Copied";
  setTimeout(() => { els.copyBridge.textContent = "Copy Bridge Tag"; }, 1200);
});

$$(".preset").forEach(button => {
  button.addEventListener("click", () => {
    $$(".preset").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    applyViewport(button.dataset.width, button.dataset.height);
  });
});

els.fitViewport.addEventListener("change", () => {
  const active = $(".preset.active");
  applyViewport(active.dataset.width, active.dataset.height);
});
els.zoom.addEventListener("change", () => {
  const active = $(".preset.active");
  applyViewport(active.dataset.width, active.dataset.height);
});
els.autoRefresh.addEventListener("change", () => {
  if (window.autoRefreshTimer) clearInterval(window.autoRefreshTimer);
  if (els.autoRefresh.checked) {
    window.autoRefreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") els.reload.click();
    }, 3000);
  }
});

$$(".tab").forEach(button => {
  button.addEventListener("click", () => {
    $$(".tab").forEach(tab => tab.classList.remove("active"));
    $$(".panel").forEach(panel => panel.classList.remove("active"));
    button.classList.add("active");
    $(`#${button.dataset.tab}Panel`).classList.add("active");
    if (button.dataset.tab === "report") els.report.textContent = buildReport();
  });
});

boot();
