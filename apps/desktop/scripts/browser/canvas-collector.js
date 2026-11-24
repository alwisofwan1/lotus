/*
 * Lotus Canvas Browser — in-page console/network/error collector (W3).
 *
 * This file is BOTH:
 *   1. `include_str!`'d into src-tauri/src/canvas_browser_snapshot.rs and injected as an
 *      INITIALIZATION script (document-start, every navigation) so it captures console
 *      output, uncaught errors, and network requests from the very first line the page runs, and
 *   2. imported-by-eval in scripts/browser/__tests__/canvas-collector.test.mjs under jsdom.
 *
 * Constraints (same as canvas-inspect.js):
 *   - No ES import/export; everything hangs off `globalThis.__lotusCollector`.
 *   - Idempotent: re-running (or a stray double-inject) must not double-wrap console/fetch.
 *   - The drain is NON-consuming — repeated drains see history; callers page with `since`.
 *
 * The Rust wrapper appends the exfiltration step onto `__lotusCollector.drain(requestId, opts)`.
 */
(() => {
  if (globalThis.__lotusCollector) return; // idempotent — install once per page context

  const CAP = 200;
  const MAX_TEXT = 600;
  const MAX_STACK = 1200;
  const MAX_URL = 600;

  // Narrow secret patterns, mirrored from canvas-inspect.js, so a logged token/JWT never reaches the
  // agent's context. Kept conservative to avoid mangling ordinary log text.
  const SECRET_PATTERNS = [
    [/\b(bearer)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, "$1 [REDACTED]"],
    [
      /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token)(["']?\s*[=:]\s*["']?)[A-Za-z0-9._~+/-]{6,}/gi,
      "$1$2[REDACTED]",
    ],
    [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED_JWT]"],
    [/\bsk-[A-Za-z0-9]{16,}\b/g, "sk-[REDACTED]"],
  ];
  const redact = (value) => {
    let out = String(value == null ? "" : value);
    for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
    return out;
  };
  const clip = (value, limit) => redact(value).slice(0, limit);

  const now = () => {
    try {
      return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    } catch {
      return Date.now();
    }
  };

  const buffer = [];
  let seq = 0;
  const record = (entry) => {
    seq += 1;
    buffer.push({ seq, ts: Math.round(now()), ...entry });
    if (buffer.length > CAP) buffer.shift();
  };

  // ── console ───────────────────────────────────────────────────────────────
  const fmtArg = (arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    console[level] = function (...args) {
      try {
        record({ kind: "console", level, text: clip(args.map(fmtArg).join(" "), MAX_TEXT) });
      } catch {
        /* never let logging break the page */
      }
      return original.apply(console, args);
    };
  }

  // ── uncaught errors + rejections ────────────────────────────────────────────
  if (typeof addEventListener === "function") {
    addEventListener("error", (event) => {
      const err = event && event.error;
      record({
        kind: "error",
        message: clip((event && event.message) || (err && err.message) || "Error", MAX_TEXT),
        stack: err && err.stack ? clip(err.stack, MAX_STACK) : undefined,
        source: event && event.filename ? clip(event.filename, MAX_URL) : undefined,
        line: event && typeof event.lineno === "number" ? event.lineno : undefined,
      });
    });
    addEventListener("unhandledrejection", (event) => {
      const reason = event && event.reason;
      record({
        kind: "error",
        message: clip("Unhandled rejection: " + ((reason && reason.message) || reason), MAX_TEXT),
        stack: reason && reason.stack ? clip(reason.stack, MAX_STACK) : undefined,
      });
    });
  }

  // ── network: fetch ──────────────────────────────────────────────────────────
  const urlOf = (input) =>
    typeof input === "string" ? input : (input && (input.url || input.href)) || String(input);
  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      const start = now();
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const url = clip(urlOf(input), MAX_URL);
      return originalFetch.apply(this, arguments).then(
        (res) => {
          record({
            kind: "network",
            method,
            url,
            status: res.status,
            ok: res.ok,
            durationMs: Math.round(now() - start),
          });
          return res;
        },
        (err) => {
          record({
            kind: "network",
            method,
            url,
            status: 0,
            ok: false,
            durationMs: Math.round(now() - start),
            errorText: clip((err && err.message) || err, MAX_TEXT),
          });
          throw err;
        },
      );
    };
  }

  // ── network: XMLHttpRequest ───────────────────────────────────────────────
  if (typeof globalThis.XMLHttpRequest === "function") {
    const OrigXHR = globalThis.XMLHttpRequest;
    const openDesc = OrigXHR.prototype.open;
    const sendDesc = OrigXHR.prototype.send;
    if (typeof openDesc === "function" && typeof sendDesc === "function") {
      OrigXHR.prototype.open = function (method, url) {
        this.__lotusMethod = String(method || "GET").toUpperCase();
        this.__lotusUrl = clip(url, MAX_URL);
        return openDesc.apply(this, arguments);
      };
      OrigXHR.prototype.send = function () {
        const start = now();
        this.addEventListener("loadend", () => {
          record({
            kind: "network",
            method: this.__lotusMethod || "GET",
            url: this.__lotusUrl || "",
            status: this.status,
            ok: this.status >= 200 && this.status < 400,
            durationMs: Math.round(now() - start),
          });
        });
        return sendDesc.apply(this, arguments);
      };
    }
  }

  const drain = (requestId, opts) => {
    const kinds =
      opts && Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds) : null;
    const since = opts && typeof opts.since === "number" ? opts.since : -1;
    const entries = buffer.filter((e) => (!kinds || kinds.has(e.kind)) && e.seq > since);
    const counts = { console: 0, error: 0, network: 0, warnings: 0, networkErrors: 0 };
    for (const e of entries) {
      if (e.kind === "console") {
        counts.console += 1;
        if (e.level === "warn") counts.warnings += 1;
      } else if (e.kind === "error") {
        counts.error += 1;
      } else if (e.kind === "network") {
        counts.network += 1;
        if (!e.ok) counts.networkErrors += 1;
      }
    }
    return {
      id: `canvas-logs-${requestId}`,
      action: "logs",
      requestId,
      url: typeof location !== "undefined" ? location.href : "",
      entries,
      counts,
      maxSeq: buffer.length ? buffer[buffer.length - 1].seq : since,
      truncated: buffer.length >= CAP,
    };
  };

  globalThis.__lotusCollector = { drain, record };
})();
