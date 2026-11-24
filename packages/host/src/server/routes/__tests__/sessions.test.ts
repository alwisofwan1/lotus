import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../app.js";
import { makeTestTaskStore } from "../../__tests__/task-store-fixture.js";
import { PtyManager } from "../../pty/manager.js";
import type { PtySession } from "../../pty/session.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { SessionNotFoundError } from "../../pty/errors.js";
import type { PtySessionState } from "../../pty/types.js";

const API_KEY = "test-api-key";

function makeSessionState(overrides?: Partial<PtySessionState>): PtySessionState {
  return {
    id: "sess-abc",
    cwd: "/home/user",
    cols: 80,
    rows: 24,
    createdAt: Date.now(),
    status: "running",
    ...overrides,
  };
}

function makeMockSession(initialBuffer = ""): {
  session: PtySession;
  emitData(chunk: string): void;
  emitExit(): void;
} {
  let buffer = initialBuffer;
  const dataHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<() => void> = [];
  const session = {
    state: makeSessionState(),
    getBufferTail: () => buffer,
    subscribeData(handler: (chunk: string) => void) {
      dataHandlers.push(handler);
      return () => {
        const idx = dataHandlers.indexOf(handler);
        if (idx >= 0) dataHandlers.splice(idx, 1);
      };
    },
    onExit(handler: () => void) { exitHandlers.push(handler); },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  } as unknown as PtySession;
  return {
    session,
    emitData(chunk) { buffer += chunk; dataHandlers.forEach((h) => h(chunk)); },
    emitExit() { exitHandlers.forEach((h) => h()); },
  };
}

function makeMockManager(): PtyManager {
  const sessions = new Map<string, PtySessionState>();
  const sessionObjects = new Map<string, PtySession>();
  return {
    create: vi.fn((req = {}) => {
      const s = makeSessionState({ cwd: (req as { cwd?: string }).cwd ?? "/tmp" });
      sessions.set(s.id, s);
      sessionObjects.set(s.id, makeMockSession().session);
      return s;
    }),
    list: vi.fn(() => [...sessions.values()]),
    getSession: vi.fn((id: string) => {
      const obj = sessionObjects.get(id);
      if (!obj) throw new SessionNotFoundError(id);
      return obj;
    }),
    write: vi.fn((id: string) => {
      if (!sessions.has(id)) throw new SessionNotFoundError(id);
    }),
    resize: vi.fn((id: string) => {
      if (!sessions.has(id)) throw new SessionNotFoundError(id);
    }),
    kill: vi.fn((id: string) => {
      if (!sessions.has(id)) throw new SessionNotFoundError(id);
      sessions.delete(id);
      sessionObjects.delete(id);
    }),
    stop: vi.fn(),
  } as unknown as PtyManager;
}

type TestServer = {
  url: string;
  stop(): Promise<void>;
  manager: PtyManager;
};

async function startTestServer(manager?: PtyManager): Promise<TestServer> {
  manager ??= makeMockManager();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const handler = createApp({
    ptyManager: manager,
    agentRunners: new AgentRunnerRegistry(),
    projectRegistry: new ProjectRegistry([]),
    notificationBus: new NotificationBus(),
    taskStore: makeTestTaskStore(), apiKey: API_KEY,
    port,
  });
  server.on("request", handler);
  return {
    url: `http://127.0.0.1:${port}`,
    manager,
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function json(method: string, url: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("GET /api/sessions", () => {
  let ts: TestServer;
  beforeEach(async () => { ts = await startTestServer(); });
  afterEach(async () => { await ts.stop(); });

  it("returns 200 with empty array when no sessions", async () => {
    const res = await json("GET", `${ts.url}/api/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns SessionInfo[] shape (id and cwd only)", async () => {
    (ts.manager.list as ReturnType<typeof vi.fn>).mockReturnValue([
      makeSessionState({ id: "s1", cwd: "/proj" }),
    ]);
    const res = await json("GET", `${ts.url}/api/sessions`);
    const body = (await res.json()) as Array<{ id: string; cwd: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({ id: "s1", cwd: "/proj" });
    expect(body[0]).not.toHaveProperty("cols");
    expect(body[0]).not.toHaveProperty("status");
  });
});

describe("POST /api/sessions", () => {
  let ts: TestServer;
  beforeEach(async () => { ts = await startTestServer(); });
  afterEach(async () => { await ts.stop(); });

  it("returns 201 with { sessionId }", async () => {
    const res = await json("POST", `${ts.url}/api/sessions`, { cwd: "/home" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    expect(typeof body.sessionId).toBe("string");
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("cols");
  });

  it("works with empty body", async () => {
    const res = await json("POST", `${ts.url}/api/sessions`);
    expect(res.status).toBe(201);
  });
});

describe("POST /api/sessions/:id/input", () => {
  let ts: TestServer;
  beforeEach(async () => { ts = await startTestServer(); });
  afterEach(async () => { await ts.stop(); });

  it("returns 204 for a known session", async () => {
    const created = await json("POST", `${ts.url}/api/sessions`, {});
    const { sessionId } = (await created.json()) as { sessionId: string };
    const res = await json("POST", `${ts.url}/api/sessions/${sessionId}/input`, { data: "ls\n" });
    expect(res.status).toBe(204);
    expect(ts.manager.write).toHaveBeenCalledWith(sessionId, "ls\n");
  });

  it("returns 404 for an unknown session", async () => {
    const res = await json("POST", `${ts.url}/api/sessions/no-such-id/input`, { data: "x" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/resize", () => {
  let ts: TestServer;
  beforeEach(async () => { ts = await startTestServer(); });
  afterEach(async () => { await ts.stop(); });

  it("returns 204 for a known session", async () => {
    const created = await json("POST", `${ts.url}/api/sessions`, {});
    const { sessionId } = (await created.json()) as { sessionId: string };
    const res = await json("POST", `${ts.url}/api/sessions/${sessionId}/resize`, { cols: 120, rows: 40 });
    expect(res.status).toBe(204);
    expect(ts.manager.resize).toHaveBeenCalledWith(sessionId, 120, 40);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await json("POST", `${ts.url}/api/sessions/ghost/resize`, { cols: 80, rows: 24 });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/sessions/:id", () => {
  let ts: TestServer;
  beforeEach(async () => { ts = await startTestServer(); });
  afterEach(async () => { await ts.stop(); });

  it("returns 204 for a known session", async () => {
    const created = await json("POST", `${ts.url}/api/sessions`, {});
    const { sessionId } = (await created.json()) as { sessionId: string };
    const res = await json("DELETE", `${ts.url}/api/sessions/${sessionId}`);
    expect(res.status).toBe(204);
    expect(ts.manager.kill).toHaveBeenCalledWith(sessionId);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await json("DELETE", `${ts.url}/api/sessions/ghost`);
    expect(res.status).toBe(404);
  });
});

// ─── SSE stream helpers ───────────────────────────────────────────────────────

function sseHeaders() {
  return { Authorization: `Bearer ${API_KEY}`, Accept: "text/event-stream" };
}

/** Reads SSE data lines until the stream closes or timeoutMs elapses. */
async function collectSseLines(url: string, timeoutMs = 2000): Promise<string[]> {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  const lines: string[] = [];
  try {
    const resp = await fetch(url, { headers: sseHeaders(), signal: ac.signal });
    const reader = resp.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) lines.push(line.slice(6));
        }
      }
    }
    reader.releaseLock();
  } catch {
    // AbortError or connection closed — normal exit
  } finally {
    clearTimeout(tid);
    ac.abort();
  }
  return lines;
}

/** Reads exactly `count` SSE data lines, aborting after timeoutMs. */
async function readSseLines(url: string, count: number, timeoutMs = 2000): Promise<string[]> {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  const lines: string[] = [];
  try {
    const resp = await fetch(url, { headers: sseHeaders(), signal: ac.signal });
    const reader = resp.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (lines.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) lines.push(line.slice(6));
        }
        if (lines.length >= count) break;
      }
    }
    reader.releaseLock();
  } catch {
    // AbortError — normal exit after collecting enough
  } finally {
    clearTimeout(tid);
    ac.abort();
  }
  return lines;
}

// ─── SSE stream tests ─────────────────────────────────────────────────────────

describe("GET /api/sessions/:id/stream", () => {
  it("returns 404 for unknown session", async () => {
    const ts = await startTestServer();
    const res = await fetch(`${ts.url}/api/sessions/ghost/stream`, { headers: sseHeaders() });
    expect(res.status).toBe(404);
    await ts.stop();
  });

  it("returns 401 without auth", async () => {
    const ts = await startTestServer();
    const res = await fetch(`${ts.url}/api/sessions/ghost/stream`);
    expect(res.status).toBe(401);
    await ts.stop();
  });

  it("returns 200 text/event-stream for known session", async () => {
    const mockSess = makeMockSession();
    const manager = {
      ...makeMockManager(),
      getSession: vi.fn((id: string) => {
        if (id === "sse-sess") return mockSess.session;
        throw new SessionNotFoundError(id);
      }),
    } as unknown as PtyManager;
    const ts = await startTestServer(manager);

    // Start the SSE fetch, then immediately emit exit so the server closes the
    // response cleanly — this lets fetch() resolve the promise naturally.
    const fetchP = fetch(`${ts.url}/api/sessions/sse-sess/stream`, { headers: sseHeaders() });
    await new Promise((r) => setTimeout(r, 30)); // let server receive the request
    mockSess.emitExit(); // server calls res.end() → fetch body completes

    const res = await fetchP;
    await res.text(); // drain body so Node.js TCP cleanup is happy
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    await ts.stop();
  });

  it("sends buffered tail immediately on connect", async () => {
    const mockSess = makeMockSession("initial-output");
    const manager = {
      ...makeMockManager(),
      getSession: vi.fn((id: string) => {
        if (id === "sse-sess") return mockSess.session;
        throw new SessionNotFoundError(id);
      }),
    } as unknown as PtyManager;
    const ts = await startTestServer(manager);

    // Close connection after receiving first event
    const lines = await readSseLines(`${ts.url}/api/sessions/sse-sess/stream`, 1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toBe("initial-output");

    await ts.stop();
  });

  it("streams new data to connected clients", async () => {
    const mockSess = makeMockSession(); // no initial tail
    const manager = {
      ...makeMockManager(),
      getSession: vi.fn((id: string) => {
        if (id === "sse-sess") return mockSess.session;
        throw new SessionNotFoundError(id);
      }),
    } as unknown as PtyManager;
    const ts = await startTestServer(manager);

    const linesP = readSseLines(`${ts.url}/api/sessions/sse-sess/stream`, 1);
    // Wait for connection to establish before emitting
    await new Promise((r) => setTimeout(r, 80));
    mockSess.emitData("live-chunk");

    const lines = await linesP;
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toBe("live-chunk");

    await ts.stop();
  });

  it("connection closes when session exits", async () => {
    const mockSess = makeMockSession();
    const manager = {
      ...makeMockManager(),
      getSession: vi.fn((id: string) => {
        if (id === "sse-sess") return mockSess.session;
        throw new SessionNotFoundError(id);
      }),
    } as unknown as PtyManager;
    const ts = await startTestServer(manager);

    // collectSseLines reads until done — should resolve quickly after emitExit
    const collectP = collectSseLines(`${ts.url}/api/sessions/sse-sess/stream`, 1500);
    await new Promise((r) => setTimeout(r, 80));
    mockSess.emitExit();

    const lines = await collectP;
    // No data was emitted before exit, so zero lines
    expect(lines).toHaveLength(0);

    await ts.stop();
  });
});
