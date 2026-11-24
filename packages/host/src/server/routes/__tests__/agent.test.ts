import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../app.js";
import { makeTestTaskStore } from "../../__tests__/task-store-fixture.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { ProviderUnavailableError } from "../../agent/errors.js";
import type { AgentRunner } from "../../agent/types.js";
import type { PtyManager } from "../../pty/manager.js";
import { SessionNotFoundError } from "../../pty/errors.js";
import type { PtySessionState } from "../../pty/types.js";

const API_KEY = "agent-test-key";

function makeSessionState(cwd = "/srv/api"): PtySessionState {
  return { id: "pty-123", cwd, cols: 80, rows: 24, createdAt: Date.now(), status: "running" };
}

function makeMockPtyManager(state?: PtySessionState): PtyManager {
  const s = state ?? makeSessionState();
  return {
    create: vi.fn(() => s),
    list: () => [s],
    getSession: (id: string) => { if (id !== s.id) throw new SessionNotFoundError(id); return {} as never; },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    stop: vi.fn(),
  } as unknown as PtyManager;
}

function makeRunner(): AgentRunner {
  return {
    providerId: "claude" as const,
    chat: vi.fn(),
    spawnPty: vi.fn(async () => undefined),
  };
}

async function startServer(
  ptyManager: PtyManager,
  registry: AgentRunnerRegistry,
  projectRegistry = new ProjectRegistry([]),
): Promise<{ url: string; server: Server }> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({ ptyManager, agentRunners: registry, projectRegistry, notificationBus: new NotificationBus(), taskStore: makeTestTaskStore(), apiKey: API_KEY, port }));
  return { url: `http://127.0.0.1:${port}`, server };
}

function stopServer(s: Server): Promise<void> {
  return new Promise((res, rej) => s.close((e) => (e ? rej(e) : res())));
}

function post(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/agent/processes", () => {
  let url: string;
  let server: Server;

  beforeEach(async () => {
    const registry = new AgentRunnerRegistry();
    registry.register(makeRunner());
    ({ url, server } = await startServer(makeMockPtyManager(), registry));
  });

  afterEach(async () => {
    await stopServer(server);
  });

  it("returns an empty process list for the PTY-only standalone host", async () => {
    const res = await fetch(`${url}/api/agent/processes`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /api/agent/spawn-pty", () => {
  let url: string;
  let server: Server;
  let runner: AgentRunner;
  let ptyManager: PtyManager;
  let registry: AgentRunnerRegistry;

  beforeEach(async () => {
    runner = makeRunner();
    ptyManager = makeMockPtyManager();
    registry = new AgentRunnerRegistry();
    registry.register(runner);
    ({ url, server } = await startServer(ptyManager, registry));
  });

  afterEach(async () => { await stopServer(server); });

  it("returns 401 without Authorization header", async () => {
    const res = await fetch(`${url}/api/agent/spawn-pty`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("returns 201 with LaunchPtyResult on valid request", async () => {
    const res = await post(`${url}/api/agent/spawn-pty`, {
      provider: "claude",
      cwd: "/srv/api",
      name: "Remote Team",
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      ok: boolean;
      teamId: string;
      sessionId: string;
      workDir: string;
      shellCmd: string;
    };
    expect(body).toEqual({
      ok: true,
      teamId: "Remote Team",
      sessionId: "pty-123",
      workDir: "/srv/api",
      shellCmd: "claude",
    });
  });

  /**
   * The posture has to arrive in BOTH places, and they are not the same place: the runner
   * builds a command line from it now, the session keeps it so the fleet can report
   * `gating` minutes later (ADR-8 — a running cell's posture cannot be taken back).
   * Carrying it into only one of the two is how the phone ends up drawing a knob the
   * machine ignores, which is the trap `issues/03` named before Phase 2 was written.
   */
  it("carries the chosen posture into both the session and the runner", async () => {
    await post(`${url}/api/agent/spawn-pty`, {
      provider: "claude",
      cwd: "/srv/api",
      permissionMode: "bypassPermissions",
    });

    expect(ptyManager.create).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
    );
    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
      expect.any(String),
    );
  });

  it("says nothing about a posture nobody chose", async () => {
    await post(`${url}/api/agent/spawn-pty`, { provider: "claude", cwd: "/srv/api" });

    const created = (ptyManager.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(created).not.toHaveProperty("permissionMode");
  });

  it("creates a PTY session with the requested cwd", async () => {
    await post(`${url}/api/agent/spawn-pty`, { provider: "claude", cwd: "/srv/myapp" });
    expect(ptyManager.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/srv/myapp" }));
  });

  it("accepts LaunchConfig projectDir as the PTY cwd", async () => {
    await post(`${url}/api/agent/spawn-pty`, {
      name: "Remote Team",
      projectDir: "/srv/mobile-app",
      leadModel: "claude-sonnet-4-6",
      agents: [],
    });
    expect(ptyManager.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/srv/mobile-app" }));
    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/srv/mobile-app", provider: "claude" }),
      "pty-123",
    );
  });

  it("accepts LaunchConfig project id from the hosted project registry", async () => {
    await stopServer(server);
    ({ url, server } = await startServer(
      ptyManager,
      registry,
      new ProjectRegistry([{ id: "mobile", name: "Mobile", path: "/srv/mobile-app" }]),
    ));

    const res = await post(`${url}/api/agent/spawn-pty`, {
      name: "Remote Team",
      project: "mobile",
      agents: [],
    });

    expect(res.status).toBe(201);
    expect(ptyManager.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/srv/mobile-app",
      provider: "claude",
      workspaceId: "mobile",
      title: "Remote Team",
    }));
    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/srv/mobile-app", provider: "claude" }),
      "pty-123",
    );
  });

  it("calls runner.spawnPty with the new session id", async () => {
    await post(`${url}/api/agent/spawn-pty`, { provider: "claude", cwd: "/srv/api" });
    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/srv/api", provider: "claude" }),
      "pty-123",
    );
  });

  it("passes optional prompt to spawnPty", async () => {
    await post(`${url}/api/agent/spawn-pty`, {
      provider: "claude",
      cwd: "/srv/api",
      prompt: "fix all the things",
    });
    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "fix all the things" }),
      "pty-123",
    );
  });

  it("threads remoteScoped through to spawnPty (ADR-0018)", async () => {
    await post(`${url}/api/agent/spawn-pty`, { provider: "claude", cwd: "/srv/api", remoteScoped: true });
    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ remoteScoped: true }),
      "pty-123",
    );
  });

  it("omits remoteScoped from the spawn request when the body does not set it", async () => {
    await post(`${url}/api/agent/spawn-pty`, { provider: "claude", cwd: "/srv/api" });
    const spawnReq = (runner.spawnPty as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect("remoteScoped" in spawnReq).toBe(false);
  });

  it("uses the first LaunchConfig agent prompt when prompt and goal are omitted", async () => {
    await post(`${url}/api/agent/spawn-pty`, {
      cwd: "/srv/api",
      agents: [
        {
          name: "Lead",
          role: "lead",
          model: "claude-sonnet-4-6",
          prompt: "Coordinate the coding task",
        },
      ],
    });
    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Coordinate the coding task" }),
      "pty-123",
    );
  });

  it("returns 400 when cwd is missing", async () => {
    const res = await post(`${url}/api/agent/spawn-pty`, { provider: "claude" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unregistered provider", async () => {
    const res = await post(`${url}/api/agent/spawn-pty`, { provider: "codex", cwd: "/srv/api" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${url}/api/agent/spawn-pty`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when runner throws ProviderUnavailableError", async () => {
    (runner.spawnPty as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ProviderUnavailableError("claude", "not found"),
    );
    const res = await post(`${url}/api/agent/spawn-pty`, { provider: "claude", cwd: "/srv/api" });
    expect(res.status).toBe(503);
  });

  it("response Content-Type is application/json", async () => {
    const res = await post(`${url}/api/agent/spawn-pty`, { provider: "claude", cwd: "/srv/api" });
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
