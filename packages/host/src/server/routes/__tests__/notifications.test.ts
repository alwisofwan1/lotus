import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../app.js";
import { makeTestTaskStore } from "../../__tests__/task-store-fixture.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import type { PtyManager } from "../../pty/manager.js";
import { SessionNotFoundError } from "../../pty/errors.js";
import type { AgentStopEvent } from "../../../types/index.js";

const API_KEY = "notif-test-key";

function makeMockPtyManager(): PtyManager {
  return {
    create: vi.fn(),
    list: () => [],
    getSession: (id: string) => { throw new SessionNotFoundError(id); },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    stop: vi.fn(),
  } as unknown as PtyManager;
}

async function startServer(bus: NotificationBus): Promise<{ url: string; server: Server }> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager: makeMockPtyManager(),
    agentRunners: new AgentRunnerRegistry(),
    projectRegistry: new ProjectRegistry([]),
    notificationBus: bus,
    taskStore: makeTestTaskStore(), apiKey: API_KEY,
    port,
  }));
  return { url: `http://127.0.0.1:${port}`, server };
}

function stopServer(s: Server): Promise<void> {
  // closeAllConnections() terminates keep-alive SSE connections immediately,
  // preventing server.close() from hanging while waiting for them to drain.
  s.closeAllConnections();
  return new Promise((res, rej) => s.close((e) => (e ? rej(e) : res())));
}

const SAMPLE_EVENT: AgentStopEvent = {
  kind: "agent_stop",
  event: "stop",
  title: "Done",
  body: "Exit 0",
  agent_type: "claude",
  status: "success",
  cwd: "/srv/api",
  timestamp: 1000,
};

describe("GET /api/notifications/stream", () => {
  let url: string;
  let server: Server;
  let bus: NotificationBus;

  beforeEach(async () => {
    bus = new NotificationBus();
    ({ url, server } = await startServer(bus));
  });

  afterEach(async () => { await stopServer(server); });

  it("returns 401 without Authorization header", async () => {
    const res = await fetch(`${url}/api/notifications/stream`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("returns 200 with text/event-stream Content-Type", async () => {
    const ac = new AbortController();
    const res = await fetch(`${url}/api/notifications/stream`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    ac.abort();
  });

  it("subscriber is registered while the request is open and removed on close", async () => {
    const ac = new AbortController();
    fetch(`${url}/api/notifications/stream`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: ac.signal,
    }).catch(() => undefined);

    await new Promise((r) => setTimeout(r, 50));
    expect(bus.size).toBe(1);

    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.size).toBe(0);
  });

  it("published event arrives as a JSON SSE data frame", async () => {
    const ac = new AbortController();
    const res = await fetch(`${url}/api/notifications/stream`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: ac.signal,
    });

    const reader = res.body!.getReader();
    // Consume the initial `: connected` flush.
    await reader.read();

    // Publish after the reader is positioned past the flush.
    bus.publish(SAMPLE_EVENT);

    const { value } = await reader.read();
    ac.abort();

    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");
    expect(text).toContain('"kind":"agent_stop"');
    expect(text).toContain('"title":"Done"');
  });
}, 15_000);
