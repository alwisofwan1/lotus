import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../../core/logger.js";
import type { ApiClient } from "../../../core/api-client.js";
import { MobileAdapter } from "../index.js";

/** Integration-level: binds a real ephemeral port, because the wiring IS the unit. */
describe("MobileAdapter", () => {
  let dir: string;
  let adapter: MobileAdapter;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lotus-adapter-"));
    const api = {
      listFleet: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
      // The adapter forwards desktop notifications, so a fake that omits this hides a
      // producer the phone depends on (job story #1).
      streamNotifications: vi.fn(() => ({
        events: () => (async function* () {})(),
        close: () => undefined,
      })),
      readScrollback: vi.fn().mockResolvedValue({ paneId: "p-1", text: "", offset: 0, totalBytes: 0 }),
      listWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      listTasks: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as ApiClient;

    adapter = new MobileAdapter({
      api,
      logger: createLogger({ sink: () => undefined }),
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      bind: { host: "127.0.0.1", port: 0 },
      devicesPath: join(dir, "devices.json"),
      fleetPollMs: 60_000,
    });
    await adapter.start();
    const addr = adapter.address();
    base = `http://127.0.0.1:${addr?.port}`;
  });

  afterEach(async () => {
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds an ephemeral port and reports it", () => {
    expect(adapter.address()?.port).toBeGreaterThan(0);
  });

  it("serves /m/pair over real HTTP", async () => {
    const { code } = adapter.createPairingCode();

    const res = await fetch(`${base}/m/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: code, deviceName: "iPhone" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).deviceToken).toBeDefined();
  });

  it("404s an unknown path instead of hanging the request", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("refuses a WebSocket upgrade without a valid token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${adapter.address()?.port}/m/stream`);

    const err = await new Promise<Error>((resolve) => ws.on("error", resolve));

    expect(err.message).toContain("401");
  });

  it("upgrades a paired device and delivers hello as the first frame", async () => {
    const { code } = adapter.createPairingCode();
    const paired = await fetch(`${base}/m/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: code, deviceName: "iPhone" }),
    });
    const { deviceToken } = (await paired.json()) as { deviceToken: string };

    const ws = new WebSocket(
      `ws://127.0.0.1:${adapter.address()?.port}/m/stream?token=${deviceToken}`,
    );
    const first = await new Promise<unknown>((resolve, reject) => {
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString())));
      ws.on("error", reject);
    });
    ws.close();

    expect(first).toMatchObject({ type: "hello", hostId: "mac", mode: "client" });
  });

  it("stops cleanly so the port is free for the next run", async () => {
    const port = adapter.address()?.port;
    await adapter.stop();

    await expect(fetch(`http://127.0.0.1:${port}/m/pair`, { method: "POST" })).rejects.toThrow();
  });
});

describe("MobileAdapter admin channel", () => {
  let dir: string;
  let adapter: MobileAdapter;

  const build = (admin?: { secret: string; advertPath: string }): MobileAdapter =>
    new MobileAdapter({
      api: {
        listFleet: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
      // The adapter forwards desktop notifications, so a fake that omits this hides a
      // producer the phone depends on (job story #1).
      streamNotifications: vi.fn(() => ({
        events: () => (async function* () {})(),
        close: () => undefined,
      })),
      readScrollback: vi.fn().mockResolvedValue({ paneId: "p-1", text: "", offset: 0, totalBytes: 0 }),
        listWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
        listTasks: vi.fn().mockResolvedValue({ items: [] }),
      } as unknown as ApiClient,
      logger: createLogger({ sink: () => undefined }),
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      bind: { host: "127.0.0.1", port: 0 },
      devicesPath: join(dir, "devices.json"),
      fleetPollMs: 60_000,
      ...(admin === undefined ? {} : { admin }),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-adapter-admin-"));
  });

  afterEach(async () => {
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // The admin channel is what lets the desktop mint a pairing code at all, so
  // this is the wiring that turns two working modules into a usable feature.
  it("mints a code over admin that the mobile façade then accepts", async () => {
    const advertPath = join(dir, "mobile-admin.json");
    const secret = "s".repeat(64);
    adapter = build({ secret, advertPath });
    await adapter.start();

    const advert = JSON.parse(readFileSync(advertPath, "utf8")) as { port: number };
    const minted = await fetch(`http://127.0.0.1:${advert.port}/admin/pairing-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(minted.status).toBe(200);
    const { code } = (await minted.json()) as { code: string };

    const paired = await fetch(`http://127.0.0.1:${adapter.address()?.port}/m/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: code, deviceName: "Phone" }),
    });

    expect(paired.status).toBe(200);
    expect((await paired.json()) as { deviceToken: string }).toHaveProperty("deviceToken");
  });

  // Run by hand without Lotus, the host must still work; it simply has no admin
  // surface, rather than an unauthenticated one.
  it("starts fine with no admin config and advertises nothing", async () => {
    adapter = build(undefined);

    await adapter.start();

    expect(adapter.address()).not.toBeNull();
    expect(() => readFileSync(join(dir, "mobile-admin.json"), "utf8")).toThrow();
  });

  it("stops the admin listener with the adapter", async () => {
    const advertPath = join(dir, "mobile-admin.json");
    adapter = build({ secret: "s".repeat(64), advertPath });
    await adapter.start();
    const advert = JSON.parse(readFileSync(advertPath, "utf8")) as { port: number };

    await adapter.stop();
    adapter = build(undefined); // so afterEach's stop() is a no-op on a fresh instance

    await expect(fetch(`http://127.0.0.1:${advert.port}/admin/health`)).rejects.toThrow();
  });

  /**
   * Found on a live restart: an orphaned host runtime from the previous run still held
   * 8787, the new façade threw EADDRINUSE from `server.listen`, and the whole host
   * runtime died — taking MCP IPC and everything else with it. One occupied port must
   * not be fatal to duties that have nothing to do with it.
   */
  it("survives a port that is already taken, and says so instead of dying", async () => {
    const busyDir = mkdtempSync(join(tmpdir(), "lotus-mobile-busy-"));
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const port = (blocker.address() as AddressInfo).port;
    const warned: string[] = [];

    const busy = new MobileAdapter({
      api: {
        listFleet: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
        streamNotifications: vi.fn(() => ({
          events: () => (async function* () {})(),
          close: () => undefined,
        })),
      } as unknown as ApiClient,
      // The sink receives a JSON line, so the assertion reads the event out of it.
      logger: createLogger({ sink: (line) => warned.push(line) }),
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      bind: { host: "127.0.0.1", port },
      devicesPath: join(busyDir, "devices.json"),
      fleetPollMs: 60_000,
    });

    await expect(busy.start()).resolves.toBeUndefined();

    // Null address is how the desktop already tells "not bound" from "bound to
    // loopback" — the same signal, now reached without a crash.
    expect(busy.address()).toBeNull();
    expect(warned.some((line) => line.includes('"event":"mobile.bind_failed"'))).toBe(true);
    expect(warned.some((line) => line.includes("EADDRINUSE"))).toBe(true);

    await busy.stop();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    rmSync(busyDir, { recursive: true, force: true });
  });
});

/**
 * The notification stream is the product's spine: it feeds live Chat *and* every FCM
 * wake-up. It used to be attached once, so a single interruption left every paired
 * phone connected, healthy-looking, and never told anything again.
 *
 * Found on 2026-08-07 while verifying live streaming against a real host — the phone's
 * header kept updating from the fleet poll while its transcript stayed empty, because
 * those are two different producers over the same socket and only one had died.
 */
describe("MobileAdapter — the notification stream reconnects", () => {
  let dir: string;
  let adapter: MobileAdapter;

  afterEach(async () => {
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Builds an adapter whose notification stream ends once, then stays open. */
  async function withFlakyStream(): Promise<{
    attaches: () => number;
    emit: (event: unknown) => void;
    port: number;
    pair: () => Promise<string>;
  }> {
    dir = mkdtempSync(join(tmpdir(), "lotus-adapter-retry-"));
    let attaches = 0;
    let push: ((event: unknown) => void) | null = null;

    const streamNotifications = vi.fn(() => {
      attaches += 1;
      if (attaches === 1) {
        // The desktop went away — exactly what a rebuild does to the process that
        // spawned this one.
        return { events: () => (async function* () {})(), close: (): void => undefined };
      }
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      push = (event) => {
        queue.push(event);
        wake?.();
      };
      return {
        events: async function* () {
          for (;;) {
            while (queue.length > 0) yield queue.shift();
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        // Annotated because the endless `events` generator above makes `vi.fn` infer this
        // object circularly, and TS7023 lands on `close`. Dropping `: void` brings it back.
        close: (): void => undefined,
      };
    });

    const api = {
      listFleet: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
      streamNotifications,
      readScrollback: vi.fn().mockResolvedValue({ paneId: "p-1", text: "", offset: 0, totalBytes: 0 }),
      listWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      listTasks: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as ApiClient;

    adapter = new MobileAdapter({
      api,
      logger: createLogger({ sink: () => undefined }),
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      bind: { host: "127.0.0.1", port: 0 },
      devicesPath: join(dir, "devices.json"),
      fleetPollMs: 60_000,
      // No real delay: the retry is the behaviour under test, not the wait.
      sleep: async () => undefined,
    });
    await adapter.start();

    const port = adapter.address()!.port;
    return {
      attaches: () => attaches,
      emit: (event) => push?.(event),
      port,
      pair: async () => {
        const { code } = adapter.createPairingCode();
        const res = await fetch(`http://127.0.0.1:${port}/m/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingCode: code, deviceName: "iPhone" }),
        });
        return (res.json ? await res.json() : {}).deviceToken as string;
      },
    };
  }

  it("attaches again after the stream ends", async () => {
    const h = await withFlakyStream();

    await vi.waitFor(() => expect(h.attaches()).toBeGreaterThan(1));
  });

  it("delivers events from the re-attached stream to a connected device", async () => {
    const h = await withFlakyStream();
    await vi.waitFor(() => expect(h.attaches()).toBeGreaterThan(1));

    const token = await h.pair();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/m/stream?token=${token}`);
    const frames: Array<{ type: string }> = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        frames.push(JSON.parse(raw.toString()) as { type: string });
        resolve();
      });
      ws.on("error", reject);
    });

    h.emit({ kind: "agent_stop", pane_id: "p-1", event: "stop", title: "Finished", timestamp: 1 });
    await vi.waitFor(() => expect(frames.some((f) => f.type === "notification")).toBe(true));
    ws.close();
  });
});

/**
 * Binding fails in two ways and they need different actions. The address one was
 * missing, and it is the likelier of the two on a laptop: a LAN address chosen in
 * Settings stops existing when the machine gets a new DHCP lease or joins another
 * network, and the failed bind is deliberately non-fatal — so the runtime stays up
 * with nothing listening, which reads as healthy from every angle but the phone's.
 *
 * Hit for real on 2026-08-07: `10.229.135.108` stored, `192.168.1.11` on en0.
 */
describe("MobileAdapter — a bind that fails says which failure it was", () => {
  let dir: string;

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the stale address, and where to change it", async () => {
    dir = mkdtempSync(join(tmpdir(), "lotus-adapter-bind-"));
    const warnings: Array<{ message: string; fields?: Record<string, unknown> | undefined }> = [];

    const adapter = new MobileAdapter({
      api: {
        listFleet: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
        streamNotifications: vi.fn(() => ({
          events: () => (async function* () {})(),
          close: () => undefined,
        })),
      } as unknown as ApiClient,
      logger: {
        info: () => undefined,
        audit: () => undefined,
        warn: (message: string, fields?: Record<string, unknown>) =>
          warnings.push({ message, fields }),
        error: () => undefined,
      } as unknown as ReturnType<typeof createLogger>,
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      // An address this machine does not have — TEST-NET-1, reserved for exactly this.
      bind: { host: "192.0.2.1", port: 8787 },
      devicesPath: join(dir, "devices.json"),
      fleetPollMs: 60_000,
    });

    await adapter.start();
    await adapter.stop();

    const failure = warnings.find((w) => w.message === "mobile.bind_failed");
    expect(failure, "a bind that never happened must be reported").toBeDefined();
    expect(failure?.fields?.code).toBe("EADDRNOTAVAIL");
    // The operator's next move, not just the errno.
    expect(String(failure?.fields?.hint)).toContain("not on any interface");
    expect(String(failure?.fields?.hint)).toContain("Listen on");
    // Non-fatal on purpose: PTYs and MCP keep working, only the phone cannot reach it.
    expect(adapter.address()).toBeNull();
  });
});
