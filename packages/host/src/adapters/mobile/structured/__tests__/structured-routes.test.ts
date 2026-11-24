import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { call } from "../../__tests__/support/call.js";
import { fakeBinDir } from "../../__tests__/support/fake-bin.js";
import { NativeConversation } from "../../codex-app-server/native-conversation.js";
import { AcpConversation } from "../bridges/acp/conversation.js";
import type { CodexSessionOptions } from "../../codex-app-server/session.js";
import { DeviceStore } from "../../device-store.js";
import { buildMobileRouter, type MobileRouterDeps } from "../../http-routes.js";
import { PairingService } from "../../pairing.js";
import { BridgeRegistry } from "../bridge-registry.js";
import { StructuredSessions } from "../structured-sessions.js";

const HOST = { hostId: "mac", hostLabel: "MacBook", mode: "client" } as const;

class FakeSession {
  readonly conversation: NativeConversation;
  alive = true;
  thread = "thr-1";
  prompts: string[] = [];
  constructor(opts: CodexSessionOptions) { this.conversation = new NativeConversation(opts.paneId); }
  async start(): Promise<void> {}
  async prompt(text: string): Promise<void> { this.prompts.push(text); }
  async interrupt(): Promise<void> {}
  decide(key: string): boolean {
    const p = this.conversation.pendingPermission();
    return p !== undefined && this.conversation.decide(p.requestId, key) !== undefined;
  }
  close(): void { this.alive = false; }
}

/** The same stand-in for an ACP agent: a conversation fed by hand, and no process anywhere. */
class FakeAcpSession {
  readonly conversation: AcpConversation;
  alive = true;
  thread = "sess-1";
  prompts: string[] = [];
  constructor(paneId: string, runner: string) { this.conversation = new AcpConversation(paneId, runner); }
  async start(): Promise<void> {}
  async prompt(text: string): Promise<void> { this.prompts.push(text); }
  async interrupt(): Promise<void> {}
  decide(): boolean { return false; }
  close(): void { this.alive = false; }
}

describe("routes with a structured session store", () => {
  let dir: string;
  let router: ReturnType<typeof buildMobileRouter>;
  let pairing: PairingService;
  let api: MobileRouterDeps["api"];
  let sessions: FakeSession[];
  let acp: FakeAcpSession[];
  let structured: StructuredSessions;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-structured-"));
    const devices = new DeviceStore(join(dir, "devices.json"));
    pairing = new PairingService(devices);
    sessions = [];
    // A PATH this test owns: which runners a host can start headless is read from the real
    // filesystem, so without this the answers would depend on what the machine has installed.
    const PATH = fakeBinDir(dir, ["codex", "cursor-agent"]);
    acp = [];
    structured = new StructuredSessions({
      publishNotification: () => undefined,
      fleetChanged: () => undefined,
      registry: new BridgeRegistry({
        env: { PATH },
        createCodexSession: (o) => { const s = new FakeSession(o); sessions.push(s); return s; },
        createAcpSession: (o) => { const s = new FakeAcpSession(o.paneId, o.agent.agentType); acp.push(s); return s; },
      }),
    });
    api = {
      listFleet: vi.fn().mockResolvedValue({ items: [{ paneId: "p-1", workspaceId: "ws-lotus", agentType: "claude", title: "Chase", status: "live", isAlive: true }] }),
      listWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      listProjects: vi.fn().mockResolvedValue({ items: [{ workspaceId: "ws-lotus", name: "Lotus", path: "/Users/op/code/lotus", lastOpenedAt: 1 }] }),
      listRunners: vi.fn().mockResolvedValue({ items: [] }),
      listTasks: vi.fn().mockResolvedValue({ items: [] }),
      spawnCell: vi.fn().mockResolvedValue({ paneId: "p-9" }),
      dispatchToCell: vi.fn().mockResolvedValue(undefined),
      readCellTranscript: vi.fn().mockResolvedValue({ paneId: "p-1", total: 0, entries: [] }),
      readCellPermission: vi.fn().mockResolvedValue({ paneId: "p-1", awaiting: false, prompt: null }),
    } as unknown as MobileRouterDeps["api"];
    router = buildMobileRouter({
      api, devices, pairing, host: HOST, audit: () => undefined,
      fleetSnapshot: async () => [...(await api.listFleet({})).items, ...structured.list()],
      structured,
      // Which accounts exist is a fact about the machine; a test that scanned the real home
      // directory would answer differently on every laptop.
      claudeProfiles: () => [
        { id: "default", label: "default" },
        { id: "initech", label: "initech" },
      ],
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function token(): Promise<string> {
    const { code } = pairing.create();
    const res = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });
    return (res.json as { deviceToken: string }).deviceToken;
  }

  it("advertises structured-spawn and spawns a codex cell with tui: false into the workspace's directory", async () => {
    const t = await token();
    const boot = await call(router, "GET", "/m/bootstrap", undefined, t);
    expect((boot.json as { hostCaps: { features: string[] } }).hostCaps.features).toContain("structured-spawn");

    const res = await call(router, "POST", "/m/cells", { provider: "codex", workspaceId: "ws-lotus", initialPrompt: "hi", tui: false }, t);
    expect(res.status).toBe(200);
    const { paneId } = res.json as { paneId: string };
    expect(paneId).toMatch(/^ss-/);
    expect(api.spawnCell).not.toHaveBeenCalled();
    expect(sessions[0]?.prompts).toEqual(["hi"]);

    // It is a cell now: in bootstrap beside the desktop's, and every cell route answers for it.
    const after = await call(router, "GET", "/m/bootstrap?workspaceId=ws-lotus", undefined, t);
    expect((after.json as { cells: Array<{ paneId: string }> }).cells.map((c) => c.paneId)).toEqual(["p-1", paneId]);
    await call(router, "POST", `/m/cell/${paneId}/dispatch`, { text: "more" }, t);
    expect(sessions[0]?.prompts).toEqual(["hi", "more"]);
    expect(api.dispatchToCell).not.toHaveBeenCalled();
    const conv = await call(router, "GET", `/m/cell/${paneId}/conversation`, undefined, t);
    expect((conv.json as { runner: string }).runner).toBe("codex");
    const closed = await call(router, "DELETE", `/m/cell/${paneId}`, undefined, t);
    expect(closed.status).toBe(200);
    expect(sessions[0]?.alive).toBe(false);
  });

  it("spawns a cursor cell with tui: false, over ACP, with no terminal either", async () => {
    const t = await token();
    const res = await call(router, "POST", "/m/cells", { provider: "cursor", workspaceId: "ws-lotus", initialPrompt: "read it", tui: false }, t);
    expect(res.status).toBe(200);
    expect(api.spawnCell).not.toHaveBeenCalled();
    expect(acp[0]?.prompts).toEqual(["read it"]);
    const { paneId } = res.json as { paneId: string };
    const conv = await call(router, "GET", `/m/cell/${paneId}/conversation`, undefined, t);
    expect((conv.json as { runner: string }).runner).toBe("cursor");
    const cells = (await call(router, "GET", "/m/bootstrap?workspaceId=ws-lotus", undefined, t)).json as {
      cells: Array<{ paneId: string; agentType: string; runnerLabel: string; gating: string }>;
    };
    expect(cells.cells.find((c) => c.paneId === paneId)).toMatchObject({
      agentType: "cursor",
      runnerLabel: "Cursor",
      // Probed 2026-09-06: Cursor over ACP never asks, so a cell that claimed it would would lie.
      gating: "skipped",
    });
  });

  it("names the runners it does have when refusing tui: false, and still refuses an unknown workspace", async () => {
    const t = await token();
    const refused = await call(router, "POST", "/m/cells", { provider: "claude", workspaceId: "ws-lotus", tui: false }, t);
    expect(refused.status).toBe(400);
    // The message is the fix: a phone that guessed is told what this host actually reaches.
    expect((refused.json as { error: string }).error).toBe("tui: false is available for codex, cursor on this host");
    expect((await call(router, "POST", "/m/cells", { provider: "codex", workspaceId: "ws-nope", tui: false }, t)).status).toBe(404);
    expect((await call(router, "POST", "/m/cells", { provider: "codex", tui: false }, t)).status).toBe(400);
  });

  it("refuses an account this host does not have, and names the ones it does", async () => {
    const t = await token();
    const refused = await call(router, "POST", "/m/cells",
      { provider: "codex", workspaceId: "ws-lotus", tui: false, profileId: "nope" }, t);
    expect(refused.status).toBe(400);
    // The fix is the message: a cell on the wrong account works, as somebody else.
    expect((refused.json as { error: string }).error).toBe('no account named "nope" — this host has default, initech');
  });

  it("passes the chosen account through, and remembers it on the cell", async () => {
    const t = await token();
    const res = await call(router, "POST", "/m/cells",
      { provider: "codex", workspaceId: "ws-lotus", tui: false, profileId: "initech" }, t);
    expect(res.status).toBe(200);
    const { paneId } = res.json as { paneId: string };
    expect(structured.list().find((m) => m.paneId === paneId)?.profileId).toBe("initech");
  });

  it("advertises which runners are headless, per runner, in bootstrap", async () => {
    (api.listRunners as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { id: "claude", name: "Claude", claudeFamily: false, custom: false, pinsTuning: false },
        { id: "codex", name: "Codex", claudeFamily: false, custom: false, pinsTuning: false },
        { id: "cursor", name: "Cursor Agent", claudeFamily: false, custom: false, pinsTuning: false },
        { id: "custom-hss", name: "HSS", claudeFamily: true, custom: true, pinsTuning: false },
      ],
    });
    const boot = (await call(router, "GET", "/m/bootstrap", undefined, await token())).json as {
      runners: Array<{ id: string; headless?: boolean }>;
    };
    expect(boot.runners.map((r) => [r.id, r.headless ?? false])).toEqual([
      ["claude", false],
      ["codex", true],
      ["cursor", true],
      // A claude-family wrapper is not a runner any bridge is keyed by.
      ["custom-hss", false],
    ]);
  });

  it("a permission on a structured cell is read from the approval and answered by digit through /input", async () => {
    const t = await token();
    const { paneId } = (await call(router, "POST", "/m/cells", { provider: "codex", workspaceId: "ws-lotus", tui: false }, t)).json as { paneId: string };
    const c = sessions[0]!.conversation;
    c.apply("turn/started", { turn: { id: "t1", startedAt: 1 } });
    c.requestApproval("item/commandExecution/requestApproval", { turnId: "t1", itemId: "e1", command: "rm -rf build" }, "a0");
    const perm = (await call(router, "GET", `/m/cell/${paneId}/permission`, undefined, t)).json as { awaiting: boolean; prompt: { options: Array<{ key: string }> } };
    expect(perm.awaiting).toBe(true);
    expect(perm.prompt.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect((await call(router, "POST", `/m/cell/${paneId}/input`, { data: "3" }, t)).status).toBe(200);
    expect((await call(router, "POST", `/m/cell/${paneId}/input`, { data: "3" }, t)).status).toBe(409);
  });

  it("a desktop pane still goes to the desktop", async () => {
    const t = await token();
    await call(router, "POST", "/m/cell/p-1/dispatch", { text: "x" }, t);
    expect(api.dispatchToCell).toHaveBeenCalledWith({ paneId: "p-1", command: "x" });
    const res = await call(router, "POST", "/m/cells", { provider: "codex", workspaceId: "ws-lotus" }, t);
    expect((res.json as { paneId: string }).paneId).toBe("p-9");
  });

  /**
   * The two refusals the fixture waiver points at. Both are statuses rather than bodies, and
   * both exist so the phone is never told a cell moved when it did not — the failure that had a
   * phone answering an approval eight times because a 200 meant nothing.
   */
  describe("POST /m/cell/:paneId/posture", () => {
    it("refuses a stop this host does not advertise, before touching the cell", async () => {
      const t = await token();
      const spawned = await call(
        router, "POST", "/m/cells",
        { provider: "codex", workspaceId: "ws-lotus", tui: false }, t,
      );
      const paneId = (spawned.json as { paneId: string }).paneId;

      const res = await call(router, "POST", `/m/cell/${paneId}/posture`, { mode: "nonsense" }, t);

      expect(res.status).toBe(400);
    });

    /** Codex's bridge cannot take a posture back, and the route says so instead of pretending. */
    it("answers 409 for a cell whose posture cannot be moved while it runs", async () => {
      const t = await token();
      const spawned = await call(
        router, "POST", "/m/cells",
        { provider: "codex", workspaceId: "ws-lotus", tui: false }, t,
      );
      const paneId = (spawned.json as { paneId: string }).paneId;

      const res = await call(router, "POST", `/m/cell/${paneId}/posture`, { mode: "manual" }, t);

      expect(res.status).toBe(409);
    });

    it("answers 409 for a pane this host does not hold at all", async () => {
      const t = await token();
      const res = await call(router, "POST", "/m/cell/p-1/posture", { mode: "manual" }, t);

      expect(res.status).toBe(409);
    });
  });
});
