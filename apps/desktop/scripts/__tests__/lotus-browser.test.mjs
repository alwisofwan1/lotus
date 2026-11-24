import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const baseEnv = (stateDir) => ({
  AGENT_CANVAS_API: "http://127.0.0.1:9877",
  AGENT_CANVAS_API_KEY: "secret-token",
  AGENT_CANVAS_TERMINAL_ID: "term-1",
  LOTUS_BROWSER_STATE_DIR: stateDir,
});

const UNTRUSTED_BEGIN = /\[UNTRUSTED WEB CONTENT [0-9a-f]{8}\]/;
const UNTRUSTED_END = /\[END UNTRUSTED WEB CONTENT [0-9a-f]{8}\]/;

/** Pull the JSON payload back out of the untrusted-content wrapper. */
function unwrap(stdout) {
  const lines = stdout.split("\n");
  const begin = lines.findIndex((l) => UNTRUSTED_BEGIN.test(l));
  const end = lines.findIndex((l) => UNTRUSTED_END.test(l));
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return JSON.parse(lines.slice(begin + 1, end).join("\n"));
}

describe("lotus-browser helper", () => {
  let originalFetch;
  let stateDir;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    stateDir = await mkdtemp(join(tmpdir(), "lotus-browser-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(stateDir, { recursive: true, force: true });
  });

  it("prints configured env without leaking the API key", async () => {
    const mod = await import("../lotus-browser.mjs");
    const result = await mod.runLotusBrowser(["env"], { env: baseEnv(stateDir) });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      api: "http://127.0.0.1:9877",
      terminalId: "term-1",
      apiKeyConfigured: true,
      missing: [],
    });
    expect(result.stdout).not.toContain("secret-token");
  });

  it("reports missing env vars from `env` instead of throwing", async () => {
    const mod = await import("../lotus-browser.mjs");
    const result = await mod.runLotusBrowser(["env"], {
      env: { AGENT_CANVAS_API: "http://127.0.0.1:9877", LOTUS_BROWSER_STATE_DIR: stateDir },
    });

    // Diagnostic must still print (not error to stderr) but signal failure via exit code.
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.missing).toEqual(
      expect.arrayContaining(["AGENT_CANVAS_API_KEY", "AGENT_CANVAS_TERMINAL_ID"]),
    );
    expect(parsed.apiKeyConfigured).toBe(false);
    expect(parsed.hint).toMatch(/Canvas Terminal/i);
  });

  it("opens the paired Canvas Browser Node with bearer auth", async () => {
    let captured;
    globalThis.fetch = vi.fn(async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ ok: true, url: "http://localhost:3000/" }), { status: 200 });
    });

    const mod = await import("../lotus-browser.mjs");
    const result = await mod.runLotusBrowser(["open", "localhost:3000"], { env: baseEnv(stateDir) });

    expect(result.code).toBe(0);
    expect(captured.url).toBe("http://127.0.0.1:9877/api/browser/open");
    expect(captured.init.headers.authorization).toBe("Bearer secret-token");
    expect(captured.body).toEqual({ terminalId: "term-1", url: "localhost:3000" });
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  it("resolves relative navigate targets against the last opened URL", async () => {
    const seen = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url, body });
      return new Response(JSON.stringify({ ok: true, url: "http://localhost:3000/" }), { status: 200 });
    });

    const mod = await import("../lotus-browser.mjs");
    await mod.runLotusBrowser(["open", "http://localhost:3000/app"], { env: baseEnv(stateDir) });
    const result = await mod.runLotusBrowser(["navigate", "/login"], { env: baseEnv(stateDir) });

    expect(result.code).toBe(0);
    expect(seen[1]).toEqual({
      url: "http://127.0.0.1:9877/api/browser/navigate",
      body: { terminalId: "term-1", url: "http://localhost:3000/login" },
    });
  });

  it("requests a browser snapshot wrapped in untrusted-content markers", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:9877/api/browser/snapshot");
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe("Bearer secret-token");
      expect(JSON.parse(init.body)).toEqual({ terminalId: "term-1" });
      return new Response(JSON.stringify({ ok: true, requestId: "req-1", snapshot: { title: "Home" } }), { status: 200 });
    });

    const mod = await import("../lotus-browser.mjs");
    const result = await mod.runLotusBrowser(["snapshot"], { env: baseEnv(stateDir) });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(UNTRUSTED_BEGIN);
    expect(result.stdout).toMatch(UNTRUSTED_END);
    expect(unwrap(result.stdout).snapshot.title).toBe("Home");
  });

  it("forwards a clamped --timeout to the snapshot request body", async () => {
    let body;
    globalThis.fetch = vi.fn(async (url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, requestId: "r", snapshot: {} }), { status: 200 });
    });

    const mod = await import("../lotus-browser.mjs");
    // 99999 is above the 10000 ceiling → clamped.
    const result = await mod.runLotusBrowser(["snapshot", "--timeout", "99999"], { env: baseEnv(stateDir) });

    expect(result.code).toBe(0);
    expect(body).toEqual({ terminalId: "term-1", timeoutMs: 10000 });
  });

  it("searches the current browser page for this terminal", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:9877/api/browser/search");
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe("Bearer secret-token");
      expect(JSON.parse(init.body)).toEqual({ terminalId: "term-1", query: "sign in" });
      return new Response(JSON.stringify({ ok: true, requestId: "req-1", search: { totalResults: 1 } }), { status: 200 });
    });

    const mod = await import("../lotus-browser.mjs");
    const result = await mod.runLotusBrowser(["search", "sign", "in"], { env: baseEnv(stateDir) });

    expect(result.code).toBe(0);
    expect(unwrap(result.stdout).search.totalResults).toBe(1);
  });

  it("reads the latest browser annotation for this terminal", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:9877/api/browser/annotation/latest?terminalId=term-1");
      expect(init.headers.authorization).toBe("Bearer secret-token");
      return new Response(JSON.stringify({ ok: true, annotation: null }), { status: 200 });
    });

    const mod = await import("../lotus-browser.mjs");
    const result = await mod.runLotusBrowser(["annotation", "latest"], { env: baseEnv(stateDir) });

    expect(result.code).toBe(0);
    expect(unwrap(result.stdout)).toEqual({ ok: true, annotation: null });
  });

  it("click/type/press/select post an action and wrap the result", async () => {
    const bodies = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:9877/api/browser/action");
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, requestId: "r", result: { ok: true, snapshot: {} } }), { status: 200 });
    });

    const mod = await import("../lotus-browser.mjs");
    await mod.runLotusBrowser(["click", "e5"], { env: baseEnv(stateDir) });
    await mod.runLotusBrowser(["type", "e3", "hello", "world", "--submit"], { env: baseEnv(stateDir) });
    await mod.runLotusBrowser(["press", "Enter"], { env: baseEnv(stateDir) });
    const res = await mod.runLotusBrowser(["select", "e7", "bdg"], { env: baseEnv(stateDir) });

    expect(bodies[0].action).toEqual({ type: "click", ref: "e5" });
    expect(bodies[1].action).toEqual({ type: "type", ref: "e3", text: "hello world", submit: true });
    expect(bodies[2].action).toEqual({ type: "press_key", key: "Enter" });
    expect(bodies[3].action).toEqual({ type: "select_option", ref: "e7", values: ["bdg"] });
    expect(res.stdout).toMatch(UNTRUSTED_BEGIN);
  });

  it("action passthrough parses a raw JSON action, rejecting invalid JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { ok: true } }), { status: 200 }),
    );
    const mod = await import("../lotus-browser.mjs");
    const ok = await mod.runLotusBrowser(["action", '{"type":"click","ref":"e1"}'], { env: baseEnv(stateDir) });
    expect(ok.code).toBe(0);
    const bad = await mod.runLotusBrowser(["action", "{not json"], { env: baseEnv(stateDir) });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/valid JSON/);
  });

  it("aborts with a timeout message when the API hangs past the budget", async () => {
    globalThis.fetch = vi.fn((url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    );

    const mod = await import("../lotus-browser.mjs");
    const result = await mod.runLotusBrowser(["open", "localhost:3000"], {
      env: { ...baseEnv(stateDir), LOTUS_BROWSER_TIMEOUT_MS: "500" },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/timed out after 500ms/);
  });

  it("fails clearly when required Canvas Terminal env is missing", async () => {
    const mod = await import("../lotus-browser.mjs");
    const result = await mod.runLotusBrowser(["open", "localhost:3000"], { env: {} });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("AGENT_CANVAS_API");
    expect(result.stderr).toMatch(/lotus-browser env/);
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
