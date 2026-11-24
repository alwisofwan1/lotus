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
import type { AgentRunner, AgentSpawnRequest } from "../../agent/types.js";

const API_KEY = "fleet-lifecycle-key";

/** In-memory PtyManager double — no node-pty needed. Same shape as `fleet-ipc.test.ts`. */
function makeMockPty() {
  const cells = new Map<string, PtySessionState>();
  let n = 0;
  return {
    pty: {
      create: (req: Partial<PtySessionState>) => {
        const id = `pty-${++n}`;
        const state: PtySessionState = {
          id, cwd: req.cwd ?? "/w", cols: 80, rows: 24, createdAt: 0, status: "running",
          ...req,
        } as PtySessionState;
        cells.set(id, state);
        return state;
      },
      list: () => [...cells.values()],
      getSession: (id: string) => {
        if (!cells.has(id)) throw new SessionNotFoundError(id);
        return { getBufferTail: () => "", write: () => undefined };
      },
      write: () => undefined,
      kill: (id: string) => { cells.delete(id); },
    } as unknown as PtyManager,
    cells,
  };
}

/** Records what the route handed the runner — the seam this issue is about. */
function makeRunner() {
  const spawnPty = vi.fn(async (_req: AgentSpawnRequest, _id: string) => undefined);
  const runner: AgentRunner = { providerId: "claude", chat: vi.fn(), spawnPty };
  return { runner, spawnPty };
}

type Harness = {
  url: string;
  server: Server;
  spawnPty: ReturnType<typeof makeRunner>["spawnPty"];
};

async function start(extra: Partial<Parameters<typeof createApp>[0]> = {}, more: AgentRunner[] = []): Promise<Harness> {
  const mock = makeMockPty();
  const { runner, spawnPty } = makeRunner();
  const agentRunners = new AgentRunnerRegistry();
  agentRunners.register(runner);
  more.forEach((r) => agentRunners.register(r));
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager: mock.pty,
    agentRunners,
    // A real project, because this route stopped accepting a workspace it does not know
    // (`plans/pocket-vps-project-checkout/issues/01`). These tests used to pass `/w` against
    // an empty registry and relied on the fallback that issue removed — so they are updated
    // to name a workspace rather than deleted, and what they actually assert is unchanged.
    projectRegistry: new ProjectRegistry([{ id: "w", name: "w", path: "/w" }]),
    notificationBus: new NotificationBus(),
    taskStore: new SwarmTaskStore({ baseDir: mkdtempSync(join(tmpdir(), "fleet-lifecycle-")) }),
    apiKey: API_KEY,
    port,
    ...extra,
  }));
  return { url: `http://127.0.0.1:${port}`, server, spawnPty };
}

function spawn(h: Harness, body: unknown): Promise<Response> {
  return fetch(`${h.url}/api/fleet/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
}

/// `spawn-tuning` reaches the runner, or it is a picker the machine ignores.
///
/// The phone has been allowed to send `model` and `effort` since the flag existed, and
/// `SpawnCellRequest` has carried both all along — but this route read only
/// `permissionMode`, so a TUI cell was launched with the CLI's defaults whatever was
/// picked. Issue 21 of `plans/pocket-without-laptop`.
describe("POST /api/fleet/spawn — tuning reaches the runner", () => {
  let h: Harness;
  beforeEach(async () => { h = await start(); });
  afterEach(async () => { await new Promise<void>((r) => h.server.close(() => r())); });

  it("hands the runner the model and effort the caller chose", async () => {
    const res = await spawn(h, {
      provider: "claude", workspaceId: "w", model: "opus", effort: "xhigh",
    });

    expect(res.status).toBe(200);
    expect(h.spawnPty).toHaveBeenCalledTimes(1);
    expect(h.spawnPty.mock.calls[0]![0]).toMatchObject({ model: "opus", effort: "xhigh" });
  });

  it("omits them entirely when nothing was chosen, rather than sending undefined", async () => {
    // `undefined` and absent read the same in TypeScript and not on a command line: a
    // runner that spreads its request would write `--model undefined`.
    await spawn(h, { provider: "claude", workspaceId: "w" });

    const req = h.spawnPty.mock.calls[0]![0];
    expect("model" in req).toBe(false);
    expect("effort" in req).toBe(false);
  });
});

/// "Claude on account X" (`plans/portable-accounts/issues/07`): the account reaches the runner as a config dir.
describe("POST /api/fleet/spawn — the account reaches the runner", () => {
  let h: Harness;
  let chosen: string | undefined;
  const accounts = {
    machine: "box",
    claudeAccounts: () => [
      { id: "default", source: "default" as const, dir: "/h/.claude", configFile: "/h/.claude.json" },
      { id: "hss", source: "lotus" as const, dir: "/h/accounts/hss", configFile: "/h/accounts/hss/.claude.json" },
    ],
    defaults: { get: () => chosen },
  } as unknown as NonNullable<Parameters<typeof createApp>[0]["accounts"]>;
  beforeEach(async () => { chosen = undefined; h = await start({ accounts }); });
  afterEach(async () => { await new Promise<void>((r) => h.server.close(() => r())); });

  it("runs a named account under its dir, and default with the variable unset", async () => {
    await spawn(h, { provider: "claude", workspaceId: "w", profileId: "hss" });
    await spawn(h, { provider: "claude", workspaceId: "w", profileId: "default" });
    expect(h.spawnPty.mock.calls[0]![0]).toMatchObject({ configDir: "/h/accounts/hss" });
    expect(h.spawnPty.mock.calls[1]![0]).toMatchObject({ configDir: null });
  });

  it("uses the host's chosen account when none is named, and leaves the env alone with none chosen", async () => {
    chosen = "hss";
    await spawn(h, { provider: "claude", workspaceId: "w" });
    chosen = undefined;
    await spawn(h, { provider: "claude", workspaceId: "w" });
    expect(h.spawnPty.mock.calls[0]![0]).toMatchObject({ configDir: "/h/accounts/hss" });
    expect("configDir" in h.spawnPty.mock.calls[1]![0]).toBe(false);
  });

  it("refuses an unknown account by name and launches nothing", async () => {
    const res = await spawn(h, { provider: "claude", workspaceId: "w", profileId: "work" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/default, hss/);
    expect(h.spawnPty).not.toHaveBeenCalled();
  });
});

/// Legacy `ccs:<name>` (issues/07 slice D): claude on account `<name>` when this host has it, else ccs as before.
describe("POST /api/fleet/spawn — a legacy ccs runner id", () => {
  const accounts = {
    machine: "box",
    claudeAccounts: () => [{ id: "hss", source: "ccs" as const, dir: "/h/.ccs/instances/hss", configFile: "/h/.ccs/instances/hss/.claude.json" }],
    defaults: { get: () => undefined },
  } as unknown as NonNullable<Parameters<typeof createApp>[0]["accounts"]>;
  const ccs = (name: string) => ({ providerId: `ccs:${name}` as const, chat: vi.fn(), spawnPty: vi.fn(async () => undefined) });

  it("launches claude on that account when this host has it, and ccs only for one it does not", async () => {
    const hss = ccs("hss");
    const old = ccs("old");
    const h = await start({ accounts }, [hss, old]);
    await spawn(h, { provider: "ccs:hss", workspaceId: "w" });
    await spawn(h, { provider: "ccs:old", workspaceId: "w" });
    await new Promise<void>((r) => h.server.close(() => r()));

    expect(h.spawnPty).toHaveBeenCalledTimes(1);
    expect(h.spawnPty.mock.calls[0]![0]).toMatchObject({ provider: "claude", configDir: "/h/.ccs/instances/hss" });
    expect(hss.spawnPty).not.toHaveBeenCalled();
    expect(old.spawnPty).toHaveBeenCalledTimes(1);
  });
});

/// A workspace this host does not know is not a directory it may launch into.
///
/// `plans/pocket-vps-project-checkout/issues/01`. The chain is whole from a paired phone:
/// `POST /m/cells` → `ApiClient.spawnCell` → this route → `projectRegistry.get(id)?.path ?? id`,
/// so an absolute path sent as `workspaceId` became the agent's `cwd`. The headless twin
/// already refuses exactly this (`structured/headless-spawn.ts` answers 404), which is what
/// makes the difference a hole rather than a policy: two spawn paths on one host, and the
/// permissive one is the default a phone takes.
describe("POST /api/fleet/spawn — an unknown workspace is refused", () => {
  let h: Harness;
  beforeEach(async () => { h = await start(); });
  afterEach(async () => { await new Promise<void>((r) => h.server.close(() => r())); });

  it("refuses a workspaceId the registry does not know, and launches nothing", async () => {
    const res = await spawn(h, { provider: "claude", workspaceId: "/etc" });

    expect(res.status).toBe(400);
    expect(h.spawnPty).not.toHaveBeenCalled();
  });
});
