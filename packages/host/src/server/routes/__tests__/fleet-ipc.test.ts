import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { SwarmTaskStore } from "../../tasks/store.js";
import { SessionNotFoundError } from "../../pty/errors.js";
import type { PtyManager } from "../../pty/manager.js";
import type { PtySessionState } from "../../pty/types.js";
import type { AgentRunner } from "../../agent/types.js";

const API_KEY = "fleet-ipc-key";

interface Cell { state: PtySessionState; buf: string }

/** In-memory PtyManager double — no node-pty needed. */
function makeMockPty() {
  const cells = new Map<string, Cell>();
  let n = 0;
  const session = (id: string) => {
    const c = cells.get(id);
    if (!c) throw new SessionNotFoundError(id);
    return { getBufferTail: (k: number) => c.buf.slice(-k), write: (d: string) => { c.buf += d; } };
  };
  const seed = (over: Partial<PtySessionState>, buf = ""): string => {
    const id = `pty-${++n}`;
    cells.set(id, { state: { id, cwd: "/w", cols: 80, rows: 24, createdAt: 0, status: "running", ...over }, buf });
    return id;
  };
  const pty = {
    create: (req: Partial<PtySessionState>) => {
      const id = seed({
        cwd: req.cwd ?? "/w",
        ...(req.provider !== undefined ? { provider: req.provider } : {}),
        ...(req.workspaceId !== undefined ? { workspaceId: req.workspaceId } : {}),
        ...(req.title !== undefined ? { title: req.title } : {}),
      });
      return cells.get(id)!.state;
    },
    list: () => [...cells.values()].map((c) => c.state),
    getSession: session,
    write: (id: string, data: string) => session(id).write(data),
    kill: (id: string) => { if (!cells.has(id)) throw new SessionNotFoundError(id); cells.delete(id); },
  } as unknown as PtyManager;
  return { pty, cells, seed };
}

function makeRunner(): AgentRunner {
  return { providerId: "claude", chat: vi.fn(), spawnPty: vi.fn(async () => undefined) };
}

type Harness = { url: string; server: Server; mock: ReturnType<typeof makeMockPty> };

async function start(projects: ProjectRegistry = new ProjectRegistry([])): Promise<Harness> {
  const mock = makeMockPty();
  const agentRunners = new AgentRunnerRegistry();
  agentRunners.register(makeRunner());
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager: mock.pty,
    agentRunners,
    projectRegistry: projects,
    notificationBus: new NotificationBus(),
    taskStore: new SwarmTaskStore({ baseDir: mkdtempSync(join(tmpdir(), "fleet-ipc-")) }),
    apiKey: API_KEY,
    port,
  }));
  return { url: `http://127.0.0.1:${port}`, server, mock };
}

function call(h: Harness, path: string, body: unknown, auth = true): Promise<Response> {
  return fetch(`${h.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("/v1/* fleet surface", () => {
  let h: Harness;
  beforeEach(async () => { h = await start(); });
  afterEach(async () => { await new Promise<void>((r) => h.server.close(() => r())); });

  it("requires Bearer auth", async () => {
    expect((await call(h, "/v1/list-fleet", {}, false)).status).toBe(401);
  });

  // ─── list-fleet ──────────────────────────────────────────────────────────

  it("lists live cells as snake_case members with a 0 snapshot age", async () => {
    h.mock.seed({ workspaceId: "ws-a", provider: "claude" }, "hello tail");
    const json = await (await call(h, "/v1/list-fleet", {})).json() as {
      fleet: Array<{ pane_id: string; workspace_id: string; is_alive: boolean; last_output_preview?: string }>;
      snapshot_age_ms: number;
    };
    expect(json.snapshot_age_ms).toBe(0);
    expect(json.fleet).toHaveLength(1);
    expect(json.fleet[0]).toMatchObject({ workspace_id: "ws-a", is_alive: true, last_output_preview: "hello tail" });
  });

  it("filters list-fleet by workspace_id", async () => {
    h.mock.seed({ workspaceId: "ws-a" });
    h.mock.seed({ workspaceId: "ws-b" });
    const json = await (await call(h, "/v1/list-fleet", { workspace_id: "ws-a" })).json() as { fleet: unknown[] };
    expect(json.fleet).toHaveLength(1);
  });

  // ─── spawn-cell ──────────────────────────────────────────────────────────

  it("spawns a cell, resolving cwd from the project registry", async () => {
    await new Promise<void>((r) => h.server.close(() => r()));
    h = await start(new ProjectRegistry([{ id: "api", name: "API", path: "/srv/api" }]));
    const json = await (await call(h, "/v1/spawn-cell", { provider: "claude", workspace_id: "api" })).json() as {
      ok: boolean; paneId: string; cwd: string;
    };
    expect(json.ok).toBe(true);
    expect(json.cwd).toBe("/srv/api");
    expect(json.paneId).toBeTruthy();
  });

  it("rejects spawn-cell without provider or workspace_id (400)", async () => {
    expect((await call(h, "/v1/spawn-cell", { provider: "claude" })).status).toBe(400);
    expect((await call(h, "/v1/spawn-cell", { workspace_id: "api" })).status).toBe(400);
  });

  // ─── dispatch / read / close ────────────────────────────────────────────

  it("dispatches a command to a live cell and reports bytes written", async () => {
    const id = h.mock.seed({});
    const json = await (await call(h, "/v1/dispatch-to-cell", { pane_id: id, command: "ls" })).json() as {
      ok: boolean; bytesWritten: number;
    };
    expect(json.ok).toBe(true);
    // "ls" + the Enter that submits it, sent as its own write a beat later so the TUI reads
    // it as a keypress rather than as part of the paste (`dispatchWritePlan`).
    expect(json.bytesWritten).toBe(3);
    expect(h.mock.cells.get(id)?.buf).toBe("ls\r");
  });

  it("returns ok:false for dispatch to an unknown cell", async () => {
    const json = await (await call(h, "/v1/dispatch-to-cell", { pane_id: "ghost", command: "ls" })).json() as { ok: boolean };
    expect(json.ok).toBe(false);
  });

  it("reads a cell's output tail", async () => {
    const id = h.mock.seed({}, "line1\nline2\n");
    const json = await (await call(h, "/v1/read-cell-output", { pane_id: id })).json() as { ok: boolean; output: string };
    expect(json.ok).toBe(true);
    expect(json.output).toBe("line1\nline2\n");
  });

  it("returns ok:false with empty output for reading an unknown cell", async () => {
    const json = await (await call(h, "/v1/read-cell-output", { pane_id: "ghost" })).json() as { ok: boolean; output: string; bytes: number };
    expect(json).toMatchObject({ ok: false, output: "", bytes: 0 });
  });

  it("closes a cell and is idempotent for an unknown cell", async () => {
    const id = h.mock.seed({});
    expect((await (await call(h, "/v1/close-cell", { pane_id: id })).json() as { ok: boolean }).ok).toBe(true);
    expect(h.mock.cells.has(id)).toBe(false);
    expect((await (await call(h, "/v1/close-cell", { pane_id: "ghost" })).json() as { ok: boolean }).ok).toBe(true);
  });

  // ─── ensure-fleet ──────────────────────────────────────────────────────────

  it("spawns the shortfall to reach the target count", async () => {
    const json = await (await call(h, "/v1/ensure-fleet", { provider: "claude", count: 2, workspace_id: "ws" })).json() as {
      ok: boolean; aliveBefore: number; aliveAfter: number; spawned: string[];
    };
    expect(json.aliveBefore).toBe(0);
    expect(json.spawned).toHaveLength(2);
    expect(json.aliveAfter).toBe(2);
  });

  it("closes the excess oldest-first when over the target count", async () => {
    h.mock.seed({ provider: "claude", workspaceId: "ws" });
    h.mock.seed({ provider: "claude", workspaceId: "ws" });
    h.mock.seed({ provider: "claude", workspaceId: "ws" });
    const json = await (await call(h, "/v1/ensure-fleet", { provider: "claude", count: 1, workspace_id: "ws" })).json() as {
      aliveBefore: number; aliveAfter: number; closed: string[];
    };
    expect(json.aliveBefore).toBe(3);
    expect(json.closed).toHaveLength(2);
    expect(json.aliveAfter).toBe(1);
  });

  it("rejects ensure-fleet with a bad count or missing provider (400)", async () => {
    expect((await call(h, "/v1/ensure-fleet", { count: 1, workspace_id: "ws" })).status).toBe(400);
    expect((await call(h, "/v1/ensure-fleet", { provider: "claude", count: -1, workspace_id: "ws" })).status).toBe(400);
    expect((await call(h, "/v1/ensure-fleet", { provider: "claude", count: 999, workspace_id: "ws" })).status).toBe(400);
  });
});
