const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4577);
const HOST = process.env.HOST || "127.0.0.1";
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1";
const ROOT = path.join(__dirname, "public");

const clients = new Set();
const recentEvents = [];
const MAX_EVENTS = 500;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), {
    "Content-Type": "application/json; charset=utf-8"
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }
  return false;
}

function validateTarget(raw) {
  if (!raw) return { ok: false, reason: "Missing URL" };
  let target;
  try {
    target = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    return { ok: false, reason: "Only http and https targets are supported" };
  }
  if (!ALLOW_REMOTE && !isPrivateHost(target.hostname)) {
    return {
      ok: false,
      reason: "Remote targets are blocked by default. Start with ALLOW_REMOTE=1 to allow them."
    };
  }
  return { ok: true, target };
}

function broadcast(event) {
  const payload = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    ...event
  };
  recentEvents.push(payload);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();

  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(line);
  }
}

function bridgeScript() {
  return `(() => {
  if (window.__DEV_BROWSER_SAFE_BRIDGE__) return;
  window.__DEV_BROWSER_SAFE_BRIDGE__ = true;

  const endpoint = "http://127.0.0.1:${PORT}/api/events";
  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const queue = [];
  let flushing = false;

  function clean(value) {
    try {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) return value;
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  function emit(type, detail) {
    queue.push({
      type,
      source: "agent-bridge",
      level: detail && detail.level,
      url: location.href,
      title: document.title,
      sessionId,
      time: new Date().toISOString(),
      detail
    });
    flush();
  }

  function flush() {
    if (flushing || queue.length === 0) return;
    flushing = true;
    const events = queue.splice(0, 25);
    fetch(endpoint, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events })
    }).catch(() => {
      queue.unshift(...events.slice(-10));
    }).finally(() => {
      flushing = false;
      if (queue.length) setTimeout(flush, 250);
    });
  }

  ["log", "info", "warn", "error"].forEach(level => {
    const original = console[level];
    console[level] = (...args) => {
      emit("console", { level, args: args.map(clean) });
      original.apply(console, args);
    };
  });

  window.addEventListener("error", event => {
    emit("runtime-error", {
      level: "error",
      message: event.message,
      file: event.filename,
      line: event.lineno,
      column: event.colno,
      error: clean(event.error)
    });
  });

  window.addEventListener("unhandledrejection", event => {
    emit("unhandled-rejection", { level: "error", reason: clean(event.reason) });
  });

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const started = performance.now();
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
    try {
      const response = await originalFetch(...args);
      emit("network", {
        method: args[1] && args[1].method || "GET",
        url: requestUrl,
        status: response.status,
        ok: response.ok,
        durationMs: Math.round(performance.now() - started)
      });
      return response;
    } catch (error) {
      emit("network", {
        level: "error",
        method: args[1] && args[1].method || "GET",
        url: requestUrl,
        failed: true,
        durationMs: Math.round(performance.now() - started),
        error: clean(error)
      });
      throw error;
    }
  };

  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function DevBrowserXHR() {
    const xhr = new OriginalXHR();
    let method = "GET";
    let requestUrl = "";
    let started = 0;
    const open = xhr.open;
    xhr.open = function patchedOpen(m, u, ...rest) {
      method = m;
      requestUrl = u;
      return open.call(xhr, m, u, ...rest);
    };
    const send = xhr.send;
    xhr.send = function patchedSend(...args) {
      started = performance.now();
      xhr.addEventListener("loadend", () => {
        emit("network", {
          method,
          url: requestUrl,
          status: xhr.status,
          ok: xhr.status >= 200 && xhr.status < 400,
          durationMs: Math.round(performance.now() - started)
        });
      });
      return send.apply(xhr, args);
    };
    return xhr;
  };

  window.addEventListener("load", () => {
    setTimeout(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      emit("page-load", {
        level: "info",
        viewport: { width: innerWidth, height: innerHeight },
        loadMs: nav ? Math.round(nav.loadEventEnd) : null,
        domNodes: document.querySelectorAll("*").length,
        imagesMissingAlt: document.querySelectorAll("img:not([alt])").length,
        buttonsWithoutNames: Array.from(document.querySelectorAll("button")).filter(button => !button.textContent.trim() && !button.getAttribute("aria-label")).length
      });
    }, 0);
  });

  emit("bridge-ready", { level: "info", userAgent: navigator.userAgent });
})();`;
}

async function runCheck(targetUrl) {
  const validation = validateTarget(targetUrl);
  if (!validation.ok) return { ok: false, error: validation.reason };

  const started = Date.now();
  const result = {
    ok: false,
    target: validation.target.toString(),
    startedAt: new Date().toISOString(),
    checks: []
  };

  try {
    const response = await fetch(validation.target, {
      redirect: "follow",
      headers: { "User-Agent": "DevBrowserSafe/1.0" }
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    result.status = response.status;
    result.durationMs = Date.now() - started;
    result.ok = response.ok;
    result.contentType = contentType;
    result.bytes = Buffer.byteLength(text);
    result.title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [null, ""])[1].trim();

    const scripts = (text.match(/<script\b/gi) || []).length;
    const stylesheets = (text.match(/<link[^>]+rel=["']?stylesheet/gi) || []).length;
    const images = (text.match(/<img\b/gi) || []).length;
    const imagesWithoutAlt = (text.match(/<img(?![^>]*\salt=)[^>]*>/gi) || []).length;
    const buttonsWithoutNames = (text.match(/<button(?:\s[^>]*)?>\s*<\/button>/gi) || []).length;

    result.checks.push({ name: "Page responds", pass: response.ok, detail: `HTTP ${response.status}` });
    result.checks.push({ name: "HTML detected", pass: contentType.includes("html") || /<html[\s>]/i.test(text), detail: contentType || "No content-type" });
    result.checks.push({ name: "Document title", pass: Boolean(result.title), detail: result.title || "No title found" });
    result.checks.push({ name: "Image alt text", pass: imagesWithoutAlt === 0, detail: `${imagesWithoutAlt} of ${images} images missing alt text` });
    result.checks.push({ name: "Named buttons", pass: buttonsWithoutNames === 0, detail: `${buttonsWithoutNames} empty buttons found` });
    result.summary = { scripts, stylesheets, images };
  } catch (error) {
    result.error = error.message;
    result.durationMs = Date.now() - started;
    result.checks.push({ name: "Page responds", pass: false, detail: error.message });
  }

  broadcast({ type: "check-complete", source: "server", level: result.ok ? "info" : "error", detail: result });
  return result;
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, safePath));
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, content, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/agent-bridge.js") {
    send(res, 200, bridgeScript(), {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store"
    });
    return;
  }

  if (requestUrl.pathname === "/api/config") {
    json(res, 200, { port: PORT, host: HOST, allowRemote: ALLOW_REMOTE });
    return;
  }

  if (requestUrl.pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    clients.add(res);
    for (const event of recentEvents.slice(-50)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    req.on("close", () => clients.delete(res));
    return;
  }

  if (requestUrl.pathname === "/api/events" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const events = Array.isArray(payload.events) ? payload.events : [payload];
      events.filter(Boolean).slice(0, 50).forEach(broadcast);
      json(res, 202, { accepted: events.length });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/check" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      json(res, 200, await runCheck(payload.url));
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  serveStatic(req, res, requestUrl.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Dev Browser Safe running at http://${HOST}:${PORT}`);
  console.log(`Remote targets: ${ALLOW_REMOTE ? "allowed" : "blocked by default"}`);
});
