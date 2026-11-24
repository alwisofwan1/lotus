/**
 * IPC config caching in scripts/lotus-mcp-server.mjs — the sidecar used to re-read
 * lotus-mcp-ipc.json on EVERY tool call (hot path). Now it caches the config and only
 * re-reads when the connection tells it the config went stale (Lotus restart →
 * connection refused on the old port, or 401 after a secret rotation).
 *
 * Isolated from the sibling suite via a --discovery file in tmpdir + a fresh module
 * import per test (the shared ~/.claude path races across parallel test workers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(tmpdir(), "lotus-ipc-cache-test");
const IPC_PATH = join(DIR, "lotus-mcp-ipc.json");

const writeIpc = (port, secret) =>
  writeFile(IPC_PATH, JSON.stringify({ version: 1, port, secret, pid: 1 }));

const okFleet = () =>
  new Response(JSON.stringify({ fleet: [] }), { status: 200 });

// One module instance for the whole file, pointed at our isolated discovery file (the
// path is resolved from argv once at module load). Cache is reset per test instead.
const argvBeforeImport = process.argv;
process.argv = ["bun", "/tmp/lotus-mcp-server.mjs", "--discovery", IPC_PATH];
const mod = await import("../lotus-mcp-server.mjs?ipc-cache-test");
process.argv = argvBeforeImport;

async function loadServer() {
  mod.__testables.resetIpcConfigCache();
  return mod;
}

describe("lotus-mcp-server IPC config cache", () => {
  let originalFetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await mkdir(DIR, { recursive: true });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(DIR, { recursive: true, force: true });
  });

  it("reuses the config across tool calls while the connection works", async () => {
    await writeIpc(42, "tok");
    const urls = [];
    globalThis.fetch = vi.fn(async (url) => {
      urls.push(String(url));
      return okFleet();
    });
    const mod = await loadServer();

    await mod.handlers.lotus_list_fleet({});
    // A rewritten discovery file must NOT be picked up mid-flight — the healthy
    // connection proves the cached config is still the live Lotus instance.
    await writeIpc(43, "tok-new");
    await mod.handlers.lotus_list_fleet({});

    expect(urls).toEqual([
      "http://127.0.0.1:42/v1/list-fleet",
      "http://127.0.0.1:42/v1/list-fleet",
    ]);
  });

  it("recovers from a Lotus restart: connection refused → re-reads the config and retries once", async () => {
    await writeIpc(42, "tok");
    const urls = [];
    globalThis.fetch = vi.fn(async (url) => {
      urls.push(String(url));
      if (String(url).includes(":42/")) {
        // undici shape for a dead port: TypeError("fetch failed") with cause.code
        const err = new TypeError("fetch failed");
        err.cause = { code: "ECONNREFUSED" };
        throw err;
      }
      return okFleet();
    });
    const mod = await loadServer();

    await mod.handlers.lotus_list_fleet({}).catch(() => {}); // warm the cache on port 42
    await writeIpc(43, "tok-new"); // Lotus restarted on a new port
    const result = await mod.handlers.lotus_list_fleet({});

    expect(JSON.parse(result.content[0].text).fleet).toEqual([]);
    expect(urls).toEqual([
      "http://127.0.0.1:42/v1/list-fleet", // first-ever call (fresh read, not retried)
      "http://127.0.0.1:42/v1/list-fleet", // stale cached port fails…
      "http://127.0.0.1:43/v1/list-fleet", // …fresh re-read retries once and succeeds
    ]);
  });

  it("recovers from a rotated secret: 401 → re-reads the config and retries once", async () => {
    await writeIpc(42, "old-secret");
    const auths = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      auths.push(init.headers.authorization);
      if (init.headers.authorization === "Bearer old-secret") {
        return new Response("no", { status: 401, statusText: "Unauthorized" });
      }
      return okFleet();
    });
    const mod = await loadServer();

    await mod.handlers.lotus_list_fleet({}).catch(() => {}); // warm cache; first-ever call is not retried
    await writeIpc(42, "new-secret");
    const result = await mod.handlers.lotus_list_fleet({});

    expect(JSON.parse(result.content[0].text).fleet).toEqual([]);
    expect(auths).toEqual(["Bearer old-secret", "Bearer old-secret", "Bearer new-secret"]);
  });

  it("does not retry when a freshly-read config still fails — Lotus is genuinely down", async () => {
    await writeIpc(42, "tok");
    globalThis.fetch = vi.fn(async () => {
      const err = new TypeError("fetch failed");
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    });
    const mod = await loadServer();

    await expect(mod.handlers.lotus_list_fleet({})).rejects.toThrow(/fetch failed/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
