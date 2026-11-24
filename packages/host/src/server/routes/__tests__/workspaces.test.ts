import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../app.js";
import { makeTestTaskStore } from "../../__tests__/task-store-fixture.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { SessionNotFoundError } from "../../pty/errors.js";
import type { PtyManager } from "../../pty/manager.js";
import type { PtySessionState } from "../../pty/types.js";

const API_KEY = "workspaces-test-key";

function makeManager(items: PtySessionState[]): PtyManager {
  return {
    create: () => { throw new SessionNotFoundError("mock"); },
    list: () => items,
    getSession: (id: string) => { throw new SessionNotFoundError(id); },
    write: (id: string) => { throw new SessionNotFoundError(id); },
    resize: (id: string) => { throw new SessionNotFoundError(id); },
    kill: (id: string) => { throw new SessionNotFoundError(id); },
    stop: () => undefined,
  } as unknown as PtyManager;
}

async function start(ptyManager: PtyManager): Promise<{ url: string; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager,
    agentRunners: new AgentRunnerRegistry(),
    projectRegistry: new ProjectRegistry([
      { id: "api", name: "API", path: "/srv/api" },
      { id: "web", name: "Web", path: "/srv/web" },
    ]),
    notificationBus: new NotificationBus(),
    taskStore: makeTestTaskStore(), apiKey: API_KEY,
    port,
  }));
  return { url: `http://127.0.0.1:${port}`, server };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("GET /api/workspaces", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await stop(server);
    server = null;
  });

  it("groups standalone sessions by workspace", async () => {
    const state = (id: string, workspaceId: string, provider: "claude" | "codex") => ({
      id,
      cwd: `/srv/${workspaceId}`,
      cols: 80,
      rows: 24,
      createdAt: 1,
      status: "running" as const,
      workspaceId,
      provider,
    });
    const started = await start(makeManager([
      state("s1", "api", "claude"),
      state("s2", "api", "codex"),
      state("s3", "web", "claude"),
    ]));
    server = started.server;

    const res = await fetch(`${started.url}/api/workspaces`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        { workspaceId: "api", cellCount: 2, providers: ["claude", "codex"] },
        { workspaceId: "web", cellCount: 1, providers: ["claude"] },
      ],
    });
  });

  it("includes hosted projects even before a cell is running", async () => {
    const started = await start(makeManager([]));
    server = started.server;

    const res = await fetch(`${started.url}/api/workspaces`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        { workspaceId: "api", cellCount: 0, providers: [] },
        { workspaceId: "web", cellCount: 0, providers: [] },
      ],
    });
  });
});
