import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../app.js";
import { listFleetHandler } from "../fleet.js";
import { makeTestTaskStore } from "../../__tests__/task-store-fixture.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { SessionNotFoundError } from "../../pty/errors.js";
import type { PtyManager } from "../../pty/manager.js";
import type { PtySession } from "../../pty/session.js";
import type { PtySessionState } from "../../pty/types.js";
import type { AgentRunner } from "../../agent/types.js";
import { StructuredFleetRef } from "../../structured-fleet-ref.js";
import type { FleetMember } from "../../../types/fleet.js";

const API_KEY = "fleet-test-key";

function state(overrides: Partial<PtySessionState> = {}): PtySessionState {
  return {
    id: "sess-1",
    cwd: "/srv/api",
    cols: 80,
    rows: 24,
    createdAt: 1,
    status: "running",
    ...overrides,
  };
}

function session(tail = ""): PtySession {
  return {
    state: state(),
    getBufferTail: vi.fn((maxBytes?: number) => tail.slice(-(maxBytes ?? tail.length))),
    bytesSeen: Buffer.byteLength(tail, "utf8"),
    readScrollback: vi.fn((fromByte: number, maxBytes?: number) => {
      const buf = Buffer.from(tail, "utf8");
      const start = Math.max(0, Math.min(fromByte, buf.length));
      return {
        text: buf.subarray(start, start + (maxBytes ?? buf.length)).toString("utf8"),
        offset: start,
      };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onExit: vi.fn(),
    subscribeData: vi.fn(),
  } as unknown as PtySession;
}

function manager(items: PtySessionState[], sessions: Record<string, PtySession> = {}): PtyManager {
  return {
    create: vi.fn(),
    list: vi.fn(() => items),
    getSession: vi.fn((id: string) => {
      const found = sessions[id];
      if (!found) throw new SessionNotFoundError(id);
      return found;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    stop: vi.fn(),
  } as unknown as PtyManager;
}

async function start(
  ptyManager: PtyManager,
  agentRunners: AgentRunnerRegistry = new AgentRunnerRegistry(),
  structuredFleet?: StructuredFleetRef,
): Promise<{ url: string; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager,
    agentRunners,
    projectRegistry: new ProjectRegistry([{ id: "api", name: "API", path: "/srv/api" }]),
    notificationBus: new NotificationBus(),
    taskStore: makeTestTaskStore(), apiKey: API_KEY,
    port,
    ...(structuredFleet === undefined ? {} : { structuredFleet }),
  }));
  return { url: `http://127.0.0.1:${port}`, server };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function api(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("standalone fleet routes", () => {
  let server: Server;
  let url: string;
  const pty = session("hello from pty");

  beforeEach(async () => {
    ({ url, server } = await start(manager([
      state({ id: "sess-1", cwd: "/srv/api", provider: "claude", workspaceId: "api", title: "API Claude" }),
      state({ id: "sess-2", cwd: "/tmp/other", provider: "codex", workspaceId: "other", status: "exited" }),
    ], { "sess-1": pty })));
  });

  afterEach(async () => {
    await stop(server);
    vi.clearAllMocks();
  });

  /**
   * ADR-8: the posture is fixed for a cell's life, so what the fleet says about it is what
   * the phone draws its permission knob from. `issues/03` found this missing entirely —
   * `toFleetMember` never set `gating`, so opening `spawn` would have shown an operator a
   * posture the machine ignores, with no way to take it back.
   */
  it("reports what each cell will do about permissions", async () => {
    const res = await api(`${url}/api/fleet`);
    const body = await res.json();

    // A claude cell launched with no mode says nothing: the effective mode can come from state
    // this host cannot see, and absence means unknown rather than ungated (2026-09-06).
    expect(body.items[0].gating).toBeUndefined();
    // A terminal codex has no hook mechanism at all — a fact about the runner, not a
    // choice that could be unmade by respawning.
    expect(body.items[1]).toMatchObject({ paneId: "sess-2", gating: "runner_cannot" });
  });

  it("says nothing rather than guessing for a cell launched with the gate off", async () => {
    const { url: u, server: srv } = await start(manager([
      state({ id: "s-y", cwd: "/srv/api", provider: "claude", permissionMode: "yolo" }),
      // `qwen` stands for any runner this host has no posture story for.
      state({ id: "s-?", cwd: "/srv/api", provider: "qwen" }),
    ], {}));
    try {
      const body = await (await api(`${u}/api/fleet`)).json();
      expect(body.items[0].gating).toBe("skipped");
      // Absent means unknown, never ungated: a custom runner's command is arbitrary.
      expect(body.items[1].gating).toBeUndefined();
    } finally {
      await stop(srv);
    }
  });

  it("lists PTY sessions as fleet members", async () => {
    const res = await api(`${url}/api/fleet`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toMatchObject({
      paneId: "sess-1",
      workspaceId: "api",
      agentType: "claude",
      title: "API Claude",
      status: "running",
      isAlive: true,
    });
    expect(body.total).toBe(2);
  });

  // Without this, `POST /m/cell/:paneId/stop` answers 404 for every cell on a VPS:
  // the mobile façade resolves a pane to its session through `sessionId`, and a
  // Standalone Host used to omit the field even though pane and session are the
  // same object here. The host knows the truth, so the host says it.
  it("names the session behind each cell, so a remote client can address it", async () => {
    const res = await api(`${url}/api/fleet`);

    const body = await res.json();
    expect(body.items[0].sessionId).toBe("sess-1");
  });

  it("filters fleet by workspaceId", async () => {
    const res = await api(`${url}/api/fleet?workspaceId=api`);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].paneId).toBe("sess-1");
  });

  it("reads a cell output tail", async () => {
    const res = await api(`${url}/api/fleet/read`, {
      method: "POST",
      body: JSON.stringify({ paneId: "sess-1", tailBytes: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paneId: "sess-1", tail: "m pty", bytes: 5 });
  });


  it("serves scrollback from an absolute offset — the route this host never had", async () => {
    // Fase 4 (`issues/05`): without it the mobile poller asked every 250ms and got a 404
    // each time, which `output-tail.ts` swallowed — Terminal on a VPS was blank forever.
    const res = await api(`${url}/api/fleet/scrollback`, {
      method: "POST",
      body: JSON.stringify({ paneId: "sess-1", fromByte: 2, maxBytes: 3 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paneId).toBe("sess-1");
    expect(body.offset).toBe(2);
    expect(typeof body.totalBytes).toBe("number");
  });

  it("404s scrollback for a pane it does not have, rather than an empty 200", async () => {
    const res = await api(`${url}/api/fleet/scrollback`, {
      method: "POST",
      body: JSON.stringify({ paneId: "gone", fromByte: 0 }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a scrollback body with no pane id", async () => {
    const res = await api(`${url}/api/fleet/scrollback`, {
      method: "POST",
      body: JSON.stringify({ fromByte: 0 }),
    });
    expect(res.status).toBe(400);
  });

  /**
   * Two writes, not one. Until 2026-09-05 this route wrote `${command}\n` in a single call,
   * and a phone's sentence landed in Codex's composer unsent — measured on devbox-vps. A
   * TUI swallows a paste that carries its own Enter (`dispatchWritePlan`).
   */
  it("dispatches the body and the Enter as separate writes", async () => {
    const res = await api(`${url}/api/fleet/dispatch`, {
      method: "POST",
      body: JSON.stringify({ paneId: "sess-1", command: "pwd" }),
    });

    expect(res.status).toBe(200);
    expect((pty.write as ReturnType<typeof vi.fn>).mock.calls).toEqual([["pwd"], ["\r"]]);
    expect(await res.json()).toMatchObject({ paneId: "sess-1", bytesWritten: 4 });
  });

  it("writes once and submits nothing when the caller says not to append", async () => {
    await api(`${url}/api/fleet/dispatch`, {
      method: "POST",
      body: JSON.stringify({ paneId: "sess-1", command: "pwd", appendNewline: false }),
    });

    expect((pty.write as ReturnType<typeof vi.fn>).mock.calls).toEqual([["pwd"]]);
  });

  it("returns 404 when reading an unknown cell", async () => {
    const res = await api(`${url}/api/fleet/read`, {
      method: "POST",
      body: JSON.stringify({ paneId: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});

/**
 * Slice 2.2 (`plans/pocket-without-laptop`). `ApiClient.spawnCell` has always called
 * `POST /api/fleet/spawn` and `closeCell` `POST /api/fleet/close`, and **standalone never
 * registered either** (`issues/03`): `POST /m/cells` from a phone reached a 404 on this
 * host, which is a different thing from a host that refuses to spawn.
 */
describe("standalone fleet spawn and close", () => {
  let server: Server;
  let url: string;
  let ptyManager: PtyManager;
  let runner: AgentRunner;

  beforeEach(async () => {
    runner = {
      providerId: "claude",
      chat: vi.fn(),
      spawnPty: vi.fn(async () => undefined),
    } as unknown as AgentRunner;
    const registry = new AgentRunnerRegistry();
    registry.register(runner);
    ptyManager = manager([]);
    (ptyManager.create as ReturnType<typeof vi.fn>).mockImplementation(
      (req: { cwd: string }) => state({ id: "new-pane", cwd: req.cwd }),
    );
    ({ url, server } = await start(ptyManager, registry));
  });

  afterEach(async () => { await stop(server); vi.clearAllMocks(); });

  it("spawns into the project the workspaceId names, and answers with the pane", async () => {
    const res = await api(`${url}/api/fleet/spawn`, {
      method: "POST",
      body: JSON.stringify({ provider: "claude", workspaceId: "api" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      paneId: "new-pane",
      workspaceId: "api",
      cwd: "/srv/api",
      provider: "claude",
      // Pane and session are the same object on a standalone host, and the phone
      // addresses output and interrupts by session.
      sessionId: "new-pane",
    });
  });

  it("carries the posture to both the session and the runner (ADR-8)", async () => {
    await api(`${url}/api/fleet/spawn`, {
      method: "POST",
      body: JSON.stringify({ provider: "claude", workspaceId: "api", permissionMode: "acceptEdits" }),
    });

    expect(ptyManager.create).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "acceptEdits" }),
    );
    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "acceptEdits" }),
      "new-pane",
    );
  });

  it("passes the first task through as the prompt, so summon and brief are one call", async () => {
    await api(`${url}/api/fleet/spawn`, {
      method: "POST",
      body: JSON.stringify({ provider: "claude", workspaceId: "api", initialPrompt: "fix the flake" }),
    });

    expect(runner.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "fix the flake" }),
      "new-pane",
    );
  });

  it("refuses a provider this host has no runner for, by name", async () => {
    const res = await api(`${url}/api/fleet/spawn`, {
      method: "POST",
      body: JSON.stringify({ provider: "nope", workspaceId: "api" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("nope");
  });

  it("requires a provider", async () => {
    const res = await api(`${url}/api/fleet/spawn`, { method: "POST", body: JSON.stringify({ workspaceId: "api" }) });
    expect(res.status).toBe(400);
  });

  /**
   * An unknown workspace is not an error here: `ProjectRegistry` answers with the id
   * itself as a path, which is how the IPC spawn has always behaved. What must not happen
   * is a 500.
   */
  it("closes a cell, and closing one that is already gone still counts as closed", async () => {
    const res = await api(`${url}/api/fleet/close`, {
      method: "POST",
      body: JSON.stringify({ paneId: "new-pane" }),
    });
    expect(res.status).toBe(200);
    expect(ptyManager.kill).toHaveBeenCalledWith("new-pane");

    (ptyManager.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new SessionNotFoundError("new-pane");
    });
    const again = await api(`${url}/api/fleet/close`, {
      method: "POST",
      body: JSON.stringify({ paneId: "new-pane" }),
    });
    expect(again.status).toBe(200);
  });

  it("requires a paneId to close", async () => {
    const res = await api(`${url}/api/fleet/close`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  /**
   * The line under a cell's name. A claude terminal cell had none — beside a Codex cell that
   * did — while the title the operator was looking for sat in the runner's own transcript all
   * along (`transcript/claude-transcript.ts`, reported from a phone on 2026-09-08).
   *
   * Injected rather than read here, because the fleet is polled every three seconds and the
   * answer only changes when the agent speaks: `app.ts` keeps it from the read the transcript
   * emitter already does.
   */
  describe("the headline", () => {
    function list(
      headlineOf?: (paneId: string) => string | undefined,
      turnOf?: (paneId: string) => { status: string; at: number } | undefined,
    ): Promise<any> {
      const handler = listFleetHandler(manager([state({ id: "s-1", provider: "claude" })]), headlineOf, turnOf);
      const req = new EventEmitter() as IncomingMessage;
      req.method = "GET";
      req.url = "/api/fleet";
      req.headers = {};
      return new Promise((resolve) => {
        const chunks: string[] = [];
        const res = {
          writeHead() { return res; },
          end(chunk?: string) { if (chunk) chunks.push(chunk); resolve(JSON.parse(chunks.join(""))); },
        } as unknown as ServerResponse;
        void handler(req, res, {});
      });
    }

    it("carries what the host could read for that cell", async () => {
      const body = await list((paneId) => (paneId === "s-1" ? "Pembuatan pantun" : undefined));
      expect(body.items[0]).toMatchObject({ paneId: "s-1", headline: "Pembuatan pantun" });
    });

    /**
     * The host records its own hooks, so it can say what a cell is doing. It did not until
     * 2026-09-08, and a phone drew *state unknown* over a pane whose hooks were arriving fine.
     */
    it("carries the turn its hooks reported, with its age", async () => {
      const body = await list(undefined, () => ({ status: "needs-input", at: Date.now() - 4000 }));
      expect(body.items[0].turn).toBe("needs-input");
      expect(body.items[0].turnAgeMs).toBeGreaterThanOrEqual(4000);
    });

    it("says nothing about a pane no hook has spoken for", async () => {
      // *No hook has spoken* and *the cell is idle* are different claims.
      const row = await list(undefined, () => undefined).then((b) => b.items[0]);
      expect(row).not.toHaveProperty("turn");
      expect(row).not.toHaveProperty("turnAgeMs");
    });

    it("is absent when nothing could be read, rather than an empty line", async () => {
      // Absent and empty are different claims everywhere else in this contract; a cell with no
      // title yet must not draw a blank second line.
      expect(await list(() => undefined).then((b) => b.items[0])).not.toHaveProperty("headline");
      expect(await list().then((b) => b.items[0])).not.toHaveProperty("headline");
    });
  });
});


/**
 * A `ccs` account is the claude binary under another config dir, and the fleet has to say both
 * things about it: the family a client routes on, and the name the operator reads. Recorded
 * only from 2026-09-08 — before that its pane had no provider at all, so its transcript could
 * not be placed and Chat was refused for the whole family.
 */
describe("a claude-family runner in the fleet", () => {
  it("routes as claude and reads as its own account", async () => {
    const handler = listFleetHandler(manager([
      state({ id: "s-ccs", provider: "claude", runnerLabel: "initech" }),
      state({ id: "s-native", provider: "claude" }),
    ]));
    const req = new EventEmitter() as IncomingMessage;
    req.method = "GET";
    req.url = "/api/fleet";
    req.headers = {};
    const body = await new Promise<any>((resolve) => {
      const chunks: string[] = [];
      const res = {
        writeHead() { return res; },
        end(chunk?: string) { if (chunk) chunks.push(chunk); resolve(JSON.parse(chunks.join(""))); },
      } as unknown as ServerResponse;
      void handler(req, res, {});
    });
    expect(body.items[0]).toMatchObject({ agentType: "claude", runnerLabel: "initech" });
    // A native runner's family already is its name; a second field would be noise.
    expect(body.items[1]).not.toHaveProperty("runnerLabel");
  });
});

/**
 * The gap this closes, found on a real machine rather than here.
 *
 * `GET /m/bootstrap` has always merged both kinds of cell; `POST /v1/list-fleet` read only
 * the PTY manager. Nothing notices until something outside the phone asks what the host is
 * running — and then a cell started from Pocket with `tui: false` is simply absent. Measured
 * on devbox-vps 2026-09-17: the audit log said `cell.spawned tui="false"`, `/v1/list-fleet`
 * said `{"fleet":[]}`.
 */
describe("/v1/list-fleet sees the cells that have no terminal", () => {
  let server: Server;
  let url: string;
  let structured: StructuredFleetRef;

  const headless = (over: Partial<FleetMember> = {}): FleetMember => ({
    paneId: "ss-9f3a1c22",
    workspaceId: "/srv/api",
    agentType: "claude",
    title: "Haloo",
    status: "live",
    isAlive: true,
    ...over,
  } as FleetMember);

  beforeEach(async () => {
    structured = new StructuredFleetRef();
    ({ url, server } = await start(
      manager([state({ id: "sess-1", cwd: "/srv/api", provider: "claude", workspaceId: "api", title: "API Claude" })]),
      new AgentRunnerRegistry(),
      structured,
    ));
  });

  afterEach(async () => {
    await stop(server);
    vi.clearAllMocks();
  });

  it("reports nothing extra while no adapter has bound one", async () => {
    const json = await (await api(`${url}/v1/list-fleet`, { method: "POST", body: "{}" })).json() as
      { fleet: { pane_id: string }[] };
    expect(json.fleet.map((m) => m.pane_id)).toEqual(["sess-1"]);
  });

  it("merges them once the adapter has, and says which kind each one is", async () => {
    structured.bind({ list: () => [headless()], page: () => undefined });

    const json = await (await api(`${url}/v1/list-fleet`, { method: "POST", body: "{}" })).json() as
      { fleet: { pane_id: string; tui: boolean; provider: string }[] };

    expect(json.fleet.map((m) => m.pane_id)).toEqual(["sess-1", "ss-9f3a1c22"]);
    // The field a caller acts on: one can be attached to over ssh, the other has no terminal
    // at all. Guessing from the `ss-` prefix would work today and break when it moved.
    expect(json.fleet.find((m) => m.pane_id === "sess-1")?.tui).toBe(true);
    expect(json.fleet.find((m) => m.pane_id === "ss-9f3a1c22")?.tui).toBe(false);
  });

  it("filters headless cells by workspace the same way", async () => {
    structured.bind({
      list: (workspaceId?: string) =>
        [headless(), headless({ paneId: "ss-other", workspaceId: "/srv/elsewhere" })]
          .filter((m) => workspaceId === undefined || m.workspaceId === workspaceId),
      page: () => undefined,
    });

    const json = await (await api(`${url}/v1/list-fleet`, {
      method: "POST",
      body: JSON.stringify({ workspace_id: "/srv/api" }),
    })).json() as { fleet: { pane_id: string }[] };

    expect(json.fleet.map((m) => m.pane_id)).toEqual(["ss-9f3a1c22"]);
  });

  it("gives a headless cell a name under verbose, like every other row", async () => {
    structured.bind({ list: () => [headless()], page: () => undefined });

    const json = await (await api(`${url}/v1/list-fleet`, {
      method: "POST",
      body: JSON.stringify({ verbose: true }),
    })).json() as { fleet: { pane_id: string; display_name?: string }[] };

    expect(json.fleet.find((m) => m.pane_id === "ss-9f3a1c22")?.display_name).toBe("Haloo");
  });
});

/**
 * A headless cell cannot be read as bytes, so `read-cell-output` is not an answer for it.
 *
 * `GET /m/cell/:paneId/conversation` already serves these from memory for the phone; this is
 * the same page for a caller holding the host's discovery file instead of a device token.
 */
describe("/v1/cell-conversation, for cells that have no terminal", () => {
  let server: Server;
  let url: string;
  let structured: StructuredFleetRef;

  const page = { paneId: "ss-9f3a1c22", runner: "claude", hostSupports: true, turns: [] };

  beforeEach(async () => {
    structured = new StructuredFleetRef();
    ({ url, server } = await start(manager([]), new AgentRunnerRegistry(), structured));
  });

  afterEach(async () => {
    await stop(server);
    vi.clearAllMocks();
  });

  it("serves the page the phone's route serves, unchanged", async () => {
    structured.bind({ list: () => [], page: (id) => (id === "ss-9f3a1c22" ? page as never : undefined) });

    const json = await (await api(`${url}/v1/cell-conversation`, {
      method: "POST",
      body: JSON.stringify({ pane_id: "ss-9f3a1c22" }),
    })).json() as { ok: boolean; paneId: string; runner: string };

    expect(json.ok).toBe(true);
    expect(json.paneId).toBe("ss-9f3a1c22");
    expect(json.runner).toBe("claude");
  });

  /// Not a 404: the caller asked a reasonable question about a pane that may simply have a
  /// terminal instead, and "not here" is a different answer from "you are wrong".
  it("says so plainly for a pane this host does not run headless", async () => {
    structured.bind({ list: () => [], page: () => undefined });

    const res = await api(`${url}/v1/cell-conversation`, {
      method: "POST",
      body: JSON.stringify({ pane_id: "sess-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, paneId: "sess-1" });
  });

  it("refuses a request with no pane at all", async () => {
    const res = await api(`${url}/v1/cell-conversation`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });

  it("answers the same way on a host whose adapter runs none", async () => {
    const res = await api(`${url}/v1/cell-conversation`, {
      method: "POST",
      body: JSON.stringify({ pane_id: "ss-anything" }),
    });
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
