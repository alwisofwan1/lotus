import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../app.js";
import { bridgeChatHandler } from "../bridge.js";
import { makeTestTaskStore } from "../../__tests__/task-store-fixture.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { ProviderUnavailableError } from "../../agent/errors.js";
import type { AgentRunner, AgentChatResponse } from "../../agent/types.js";
import type { PtyManager } from "../../pty/manager.js";
import { SessionNotFoundError } from "../../pty/errors.js";

const API_KEY = "bridge-test-key";

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

function makeRunner(
  overrides: Partial<AgentChatResponse> = {},
): AgentRunner {
  return {
    providerId: "claude" as const,
    chat: vi.fn(async (): Promise<AgentChatResponse> => ({
      sessionId: "new-sess",
      text: "response text",
      isError: false,
      provider: "claude",
      ...overrides,
    })),
    spawnPty: vi.fn(),
  };
}

async function startServer(
  registry: AgentRunnerRegistry,
  projectRegistry = new ProjectRegistry([]),
): Promise<{ url: string; server: Server }> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager: makeMockPtyManager(),
    agentRunners: registry,
    projectRegistry,
    notificationBus: new NotificationBus(),
    taskStore: makeTestTaskStore(), apiKey: API_KEY,
    port,
  }));
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

describe("POST /api/bridge/chat", () => {
  let url: string;
  let server: Server;
  let runner: AgentRunner;
  let registry: AgentRunnerRegistry;

  beforeEach(async () => {
    runner = makeRunner();
    registry = new AgentRunnerRegistry();
    registry.register(runner);
    ({ url, server } = await startServer(registry));
  });

  afterEach(async () => { await stopServer(server); });

  it("returns 401 without Authorization header", async () => {
    const res = await fetch(`${url}/api/bridge/chat`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with BridgeChatResponse on valid request", async () => {
    const res = await post(`${url}/api/bridge/chat`, {
      text: "hello",
      cwd: "/srv/api",
      provider: "claude",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; text: string; isError: boolean; provider: string };
    expect(body.sessionId).toBe("new-sess");
    expect(body.text).toBe("response text");
    expect(body.isError).toBe(false);
    expect(body.provider).toBe("claude");
  });

  it("defaults to provider=claude when not specified", async () => {
    const res = await post(`${url}/api/bridge/chat`, { text: "hi", cwd: "/srv/api" });
    expect(res.status).toBe(200);
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude" }));
  });

  it("passes cwd and text to runner.chat", async () => {
    await post(`${url}/api/bridge/chat`, { text: "do work", cwd: "/srv/myproject", provider: "claude" });
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "do work",
      cwd: "/srv/myproject",
    }));
  });

  it("threads remoteScoped through to runner.chat (ADR-0018)", async () => {
    await post(`${url}/api/bridge/chat`, { text: "go", cwd: "/srv/api", remoteScoped: true });
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({ remoteScoped: true }));
  });

  it("defaults remoteScoped to false when the body omits it", async () => {
    await post(`${url}/api/bridge/chat`, { text: "go", cwd: "/srv/api" });
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({ remoteScoped: false }));
  });

  it("rejects cwd outside configured Hosted Projects", async () => {
    await stopServer(server);
    ({ url, server } = await startServer(registry, new ProjectRegistry([
      { id: "api", name: "API", path: "/srv/api" },
    ])));

    const res = await post(`${url}/api/bridge/chat`, {
      text: "hi",
      cwd: "/etc",
      provider: "claude",
    });

    expect(res.status).toBe(403);
    expect(runner.chat).not.toHaveBeenCalled();
  });

  it("allows cwd inside a configured Hosted Project", async () => {
    await stopServer(server);
    ({ url, server } = await startServer(registry, new ProjectRegistry([
      { id: "api", name: "API", path: "/srv/api" },
    ])));

    const res = await post(`${url}/api/bridge/chat`, {
      text: "hi",
      cwd: "/srv/api/packages/web",
      provider: "claude",
    });

    expect(res.status).toBe(200);
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/srv/api/packages/web",
    }));
  });

  it("rejects write intent in a read-only Hosted Project", async () => {
    await stopServer(server);
    ({ url, server } = await startServer(registry, new ProjectRegistry([
      { id: "docs", name: "Docs", path: "/srv/docs", policy: "read-only" },
    ])));

    const res = await post(`${url}/api/bridge/chat`, {
      text: "edit docs",
      cwd: "/srv/docs",
      provider: "claude",
      intent: "write",
      approved: true,
    });

    expect(res.status).toBe(403);
    expect(runner.chat).not.toHaveBeenCalled();
  });

  it("requires approval for write intent in an approval-required Hosted Project", async () => {
    await stopServer(server);
    ({ url, server } = await startServer(registry, new ProjectRegistry([
      { id: "api", name: "API", path: "/srv/api", policy: "approval-required" },
    ])));

    const res = await post(`${url}/api/bridge/chat`, {
      text: "edit api",
      cwd: "/srv/api",
      provider: "claude",
      intent: "write",
    });

    expect(res.status).toBe(403);
    expect(runner.chat).not.toHaveBeenCalled();
  });

  it("allows approved write intent in an approval-required Hosted Project", async () => {
    await stopServer(server);
    ({ url, server } = await startServer(registry, new ProjectRegistry([
      { id: "api", name: "API", path: "/srv/api", policy: "approval-required" },
    ])));

    const res = await post(`${url}/api/bridge/chat`, {
      text: "edit api",
      cwd: "/srv/api",
      provider: "claude",
      intent: "write",
      approved: true,
    });

    expect(res.status).toBe(200);
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/srv/api" }));
  });

  it("threads model through to runner.chat when provided", async () => {
    await post(`${url}/api/bridge/chat`, { text: "hi", cwd: "/srv/api", provider: "claude", model: "sonnet" });
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({ model: "sonnet" }));
  });

  it("passes sessionId to runner.chat when provided", async () => {
    await post(`${url}/api/bridge/chat`, {
      text: "follow-up",
      cwd: "/srv/api",
      provider: "claude",
      sessionId: "existing-sess",
    });
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "existing-sess" }));
  });

  it("uses process.cwd() as fallback when cwd is missing", async () => {
    const res = await post(`${url}/api/bridge/chat`, { text: "hi", provider: "claude" });
    expect(res.status).toBe(200);
    expect(runner.chat).toHaveBeenCalledWith(expect.objectContaining({ cwd: process.cwd() }));
  });

  it("returns 400 when text is missing", async () => {
    const res = await post(`${url}/api/bridge/chat`, { cwd: "/srv/api", provider: "claude" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unregistered provider", async () => {
    const res = await post(`${url}/api/bridge/chat`, {
      text: "hi",
      cwd: "/srv/api",
      provider: "codex",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${url}/api/bridge/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("surfaces a provider-unavailable error frame (errorStatus 503) when the runner throws", async () => {
    (runner.chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ProviderUnavailableError("claude", "binary not found"),
    );
    // The reply is streamed (status 200 committed before the runner runs); the
    // failure rides in the final frame, which the client maps to ApiError 503.
    const res = await post(`${url}/api/bridge/chat`, { text: "hi", cwd: "/srv/api", provider: "claude" });
    expect(res.status).toBe(200);
    const body = await res.json() as { error?: string; errorStatus?: number };
    expect(body.errorStatus).toBe(503);
    expect(body.error).toContain("claude");
  });

  it("response Content-Type is application/json", async () => {
    const res = await post(`${url}/api/bridge/chat`, { text: "hi", cwd: "/srv/api", provider: "claude" });
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("POST /api/bridge/chat (streaming)", () => {
  function startHandlerServer(
    runner: AgentRunner,
    streamOpts: { heartbeatMs: number; timeoutMs: number },
  ): Promise<{ url: string; server: Server }> {
    const registry = new AgentRunnerRegistry();
    registry.register(runner);
    const handler = bridgeChatHandler(registry, new ProjectRegistry([]), streamOpts);
    const server = createServer((req, res) => void handler(req, res, {}));
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ url: `http://127.0.0.1:${port}`, server });
      });
    });
  }

  it("streams whitespace heartbeats then the final JSON for a slow turn", async () => {
    const runner: AgentRunner = {
      providerId: "claude",
      chat: vi.fn(async (): Promise<AgentChatResponse> => {
        await delay(80);
        return { sessionId: "sx", text: "late reply", isError: false, provider: "claude" };
      }),
      spawnPty: vi.fn(),
    };
    const { url, server } = await startHandlerServer(runner, { heartbeatMs: 15, timeoutMs: 5_000 });
    try {
      const res = await fetch(`${url}/`, { method: "POST", body: JSON.stringify({ text: "hi", cwd: "/tmp", provider: "claude" }) });
      const raw = await res.text();
      expect(res.status).toBe(200);
      expect(raw).toContain("\n");                       // heartbeats were emitted
      expect(JSON.parse(raw)).toMatchObject({ text: "late reply", sessionId: "sx" });
    } finally {
      await stopServer(server);
    }
  });

  it("returns a timeout error frame and aborts the runner for a hung turn", async () => {
    let aborted = false;
    const runner: AgentRunner = {
      providerId: "claude",
      chat: vi.fn((req): Promise<AgentChatResponse> => new Promise((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => { aborted = true; reject(new Error(String(req.signal?.reason))); }, { once: true });
      })),
      spawnPty: vi.fn(),
    };
    const { url, server } = await startHandlerServer(runner, { heartbeatMs: 1_000, timeoutMs: 40 });
    try {
      const res = await fetch(`${url}/`, { method: "POST", body: JSON.stringify({ text: "hang", cwd: "/tmp", provider: "claude" }) });
      const frame = JSON.parse(await res.text()) as { error?: string; errorStatus?: number };
      expect(frame.error).toContain("exceeded");
      expect(frame.errorStatus).toBe(500);
      expect(aborted).toBe(true);
    } finally {
      await stopServer(server);
    }
  });
});
