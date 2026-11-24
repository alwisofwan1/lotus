import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceStore } from "../device-store.js";
import type { FleetMember } from "../../../types/fleet.js";
import type { ServerEvent } from "../events.js";
import { buildMobileRouter, type MobileRouterDeps } from "../http-routes.js";
import { PairingService } from "../pairing.js";
import { StreamHub, type StreamSocket } from "../stream-hub.js";
import { BridgeRegistry } from "../structured/bridge-registry.js";
import { StructuredSessions } from "../structured/structured-sessions.js";
import { call } from "./support/call.js";
import { fakeBinDir } from "./support/fake-bin.js";
import { assertFixture, FIXTURES } from "./support/fixtures.js";

const HOST = { hostId: "mac", hostLabel: "MacBook", mode: "client" } as const;

/**
 * The contract is a set of real payloads both sides test against (ADR-10).
 *
 * These fixtures are produced by the live handlers, never hand-written, so a
 * shape change here forces the file to change — and the Dart side that parses
 * the same file goes red. That is the whole drift-detection mechanism; there is
 * no schema language and no codegen.
 */
describe("contract fixtures", () => {
  let dir: string;
  let devices: DeviceStore;
  let pairing: PairingService;
  let router: ReturnType<typeof buildMobileRouter>;
  let api: MobileRouterDeps["api"];
  const now = Date.parse("2026-08-02T10:00:00Z");

  const cell: FleetMember = {
    paneId: "p-1",
    workspaceId: "ws-lotus",
    agentType: "claude",
    // The desktop's own word for this runner. `agentType` says "claude" for every custom
    // Claude-family runner, so a client with only that field printed `claude` beside a
    // desktop printing `acme` — the contract now carries both.
    runnerLabel: "acme",
    // Which account this cell works as. Only answerable from here: a machine with three
    // accounts gives no other way to tell, and a running cell cannot be moved to another.
    profileId: "initech",
    title: "Chase",
    status: "live",
    isAlive: true,
    cwd: "/Users/op/code/lotus",
    workspaceLabel: "Lotus",
    lastOutputPreview: "Running tests…",
    // The ask, as the canvas card shows it — what a row's second line prefers over the
    // raw terminal tail, because it says what the agent is *for*.
    headline: "clean up the legacy files",
    sessionId: "sess-1",
    turn: "needs-input",
    turnAgeMs: 4_000,
    gating: "asks",
    model: "claude-opus-5-5",
    branch: "feat/pocket-context",
  };

  /** A second cell that cannot gate, so the contract carries both shapes. */
  const ungatedCell: FleetMember = {
    paneId: "p-2",
    workspaceId: "ws-lotus",
    agentType: "codex",
    runnerLabel: "Codex",
    title: "Marshall",
    status: "live",
    isAlive: true,
    cwd: "/Users/op/code/lotus",
    workspaceLabel: "Lotus",
    sessionId: "sess-2",
    gating: "runner_cannot",
    // A runner that says the plan is nearly out. In the fixture because absent and present
    // read differently and a client must not treat silence as health: the failure this field
    // exists for is a quota wall that arrived as an ordinary-looking reply.
    usage: { status: "allowed_warning", window: "five_hour", resetsAt: 1788763800 },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-contract-"));
    devices = new DeviceStore(join(dir, "devices.json"), () => now);
    pairing = new PairingService(devices, () => now);
    api = {
      listFleet: vi
        .fn()
        .mockResolvedValue({ items: [cell, ungatedCell], total: 2, page: 1, pageSize: 10 }),
      listWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [{ workspaceId: "ws-lotus", cellCount: 1, providers: ["claude"] }] }),
      // Two projects, one of them with no cell in `cells[]` at all. A fixture where
      // every project is also running would pass while proving nothing — the whole
      // point of `projects[]` is the row that `workspaces[]` cannot produce (ADR-14).
      listProjects: vi.fn().mockResolvedValue({
        items: [
          { workspaceId: "ws-lotus", name: "Lotus", path: "/Users/op/code/lotus", lastOpenedAt: 1754700000000 },
          { workspaceId: "ws-terax", name: "terax-ai", path: "/Users/op/code/terax-ai", lastOpenedAt: 1754600000000 },
        ],
      }),
      // What a real machine answers: detected CLIs, and the runners the operator
      // defined. The custom ones are in the fixture because they are the case a hardcoded
      // client list cannot have — names only this registry knows — and because all three
      // custom outcomes of `spawn-tuning` are decided here, not by `custom` alone.
      listRunners: vi.fn().mockResolvedValue({
        items: [
          { id: "claude", name: "Claude", claudeFamily: false, custom: false, pinsTuning: false },
          { id: "codex", name: "Codex", claudeFamily: false, custom: false, pinsTuning: false },
          // A second-account Claude wrapper whose command fixes nothing: it carries the
          // claude knobs, which treating every custom runner as flag-owning used to hide.
          { id: "custom-hss", name: "HSS", claudeFamily: true, custom: true, pinsTuning: false },
          // The same shape, except its command already names a model — so no knob.
          { id: "custom-acme", name: "acme", claudeFamily: true, custom: true, pinsTuning: true },
          // A command Lotus knows nothing about, claude-family or not: no knob either.
          { id: "custom-opencode", name: "Opencode", claudeFamily: false, custom: true, pinsTuning: false },
        ],
      }),
      listTasks: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
    } as unknown as MobileRouterDeps["api"];

    router = buildMobileRouter({
      api,
      devices,
      pairing,
      host: HOST,
      audit: () => undefined,
      fleetSnapshot: async () => [cell, ungatedCell],
      // What `~/.codex/models_cache.json` lists on a real account, best-first. Two
      // entries so the fixture shows a `default` that is *not* the only choice, and
      // a slug whose short label differs from its id (`gpt-5.4-codex` → `5.4-codex`).
      codexModels: () => [
        { slug: "gpt-5.4-codex", displayName: "GPT-5.4 Codex" },
        { slug: "gpt-5.4", displayName: "GPT-5.4" },
      ],
      // Two, because one is not a choice and the fixture must show the picker.
      claudeProfiles: () => [
        { id: "default", label: "default" },
        { id: "initech", label: "initech" },
      ],
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rest-pair matches what POST /m/pair returns", async () => {
    const { code } = pairing.create();
    const res = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });
    const body = res.json as Record<string, unknown>;

    // Token and device id are random by construction; the contract is the shape.
    assertFixture("rest-pair", { ...body, deviceToken: "<opaque>", deviceId: "dev_<hex>" });
  });

  it("rest-bootstrap matches what GET /m/bootstrap returns", async () => {
    const { code } = pairing.create();
    const paired = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });
    const token = (paired.json as { deviceToken: string }).deviceToken;

    const res = await call(router, "GET", "/m/bootstrap?workspaceId=ws-lotus", {}, token);

    assertFixture("rest-bootstrap", res.json);
  });

  /**
   * The same route on a host that can run agents without a terminal.
   *
   * A second fixture rather than a richer first one: `rest-bootstrap` is the host that
   * *cannot*, and it is the case that pins the compatibility rule — absent `headless` must
   * read as "do not offer it". Folding them together would delete the older shape from the
   * contract, and the phone has to keep parsing both.
   */
  it("rest-bootstrap-headless matches a host that advertises per-runner headless", async () => {
    const bin = fakeBinDir(dir, ["codex", "cursor-agent"]);
    const structured = new StructuredSessions({
      publishNotification: () => undefined,
      fleetChanged: () => undefined,
      registry: new BridgeRegistry({ env: { PATH: bin } }),
    });
    (api.listRunners as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { id: "claude", name: "Claude", claudeFamily: false, custom: false, pinsTuning: false },
        { id: "codex", name: "Codex", claudeFamily: false, custom: false, pinsTuning: false },
        // No `cursor` row: this host has no PTY runner for it, which is the truth on every
        // machine — it is a bridge and nothing else. The row in the fixture is the one
        // `tuneRunners` adds for it, and it says `terminal: false`.
      ],
    });
    const headlessRouter = buildMobileRouter({
      api, devices, pairing, host: HOST, audit: () => undefined,
      fleetSnapshot: async () => [cell],
      structured,
      codexModels: () => [{ slug: "gpt-5.4-codex", displayName: "GPT-5.4 Codex" }],
      // Without this the route scans this machine's real accounts, and the fixture holds its paths.
      claudeProfiles: () => [{ id: "default", label: "default" }, { id: "initech", label: "initech" }],
    });
    const { code } = pairing.create();
    const paired = await call(headlessRouter, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });
    const token = (paired.json as { deviceToken: string }).deviceToken;

    const res = await call(headlessRouter, "GET", "/m/bootstrap?workspaceId=ws-lotus", {}, token);

    assertFixture("rest-bootstrap-headless", res.json);
  });

  it("stream events match what StreamHub emits", () => {
    const sent: ServerEvent[] = [];
    const socket: StreamSocket = {
      send: (data) => sent.push(JSON.parse(data) as ServerEvent),
      close: () => undefined,
    };
    const hub = new StreamHub({ host: HOST });
    const conn = hub.attach(socket, devices.issue("iPhone"));
    hub.handleMessage(conn, JSON.stringify({ type: "subscribe", paneId: "p-1" }));

    hub.publishFleet([cell, ungatedCell]);
    hub.publishOutput("p-1", "npm test\n", 4096);
    hub.publishTruncated("p-1", 1024, 4096);
    // No `as never`: the previous cast let this fixture document `agent-stop`
    // with camelCase fields, a shape the host never emits. The real event is
    // `agent_stop` in snake_case, and a Dart model written from the old fixture
    // would have failed on the first real frame.
    hub.publishNotification({
      kind: "agent_stop",
      pane_id: "p-1",
      agent_type: "claude",
      event: "tool-pre",
      tool_target: "rm src/legacy/shim.ts",
      title: "Bash",
      body: "Do you want to run this command?",
      status: "needs-input",
      // Carried so a client can rebuild one whole Chat line from a single frame —
      // without it the "you asked" bubble waits for an HTTP refetch. In the fixture
      // for the same reason the diff-less transcript entry is: a field that is easy
      // to forget should not be gettable by accident.
      user_prompt: "clean up the legacy files",
      lines_added: 0,
      lines_removed: 34,
      cwd: "/Users/op/code/lotus",
      timestamp: now,
    });

    // The conversation lane, published for the same step as the notification above. Both
    // ride for every step (ADR-4): the entry keeps shipped phones working, this carries what
    // an entry cannot say — a part revised in place, a turn closing with its stop reason.
    hub.publishConversation("p-1", "claude", {
      kind: "part",
      turnId: "t-9f2a1c",
      part: {
        id: "b41c07d2",
        ts: now,
        seq: 3,
        provenance: "hook",
        type: "tool_call",
        toolCallId: "b41c07d2",
        toolName: "Bash",
        title: "rm src/legacy/shim.ts",
        kind: "execute",
        status: "completed",
        locations: [{ path: "src/legacy/shim.ts" }],
        diff: { files: [{ path: "src/legacy/shim.ts", op: "modify", deletions: 34 }] },
      },
    });

    // Captured **before** the overflow below, or the last `conversation` frame on the wire
    // would be one of that loop's turn updates and this fixture would stop describing a step.
    const byType = new Map(sent.map((e) => [e.type, e]));

    // Streaming prose, in the two frames it takes: the `part` that opens it, then the
    // characters that grew it. Published **after** `byType` was taken, because that map keeps
    // the last frame of each type — publishing these first would quietly turn the
    // `stream-conversation` fixture into a chunk instead of a step.
    hub.publishConversation("p-1", "claude", {
      kind: "part",
      turnId: "t-9f2a1c",
      part: {
        id: "t-9f2a1c-text",
        ts: now,
        seq: 4,
        provenance: "native",
        type: "assistant_text",
        text: "Removing the",
        state: "streaming",
        truncated: false,
      },
    });
    hub.publishConversation("p-1", "claude", {
      kind: "text",
      turnId: "t-9f2a1c",
      partId: "t-9f2a1c-text",
      delta: " shim now.",
      seq: 5,
    });
    assertFixture(
      "stream-conversation-text",
      sent.find((e) => e.type === "conversation" && e.update.kind === "text"),
    );


    // Overflow the resume log so the truncated frame is generated rather than hand-written:
    // its shape has to be what a client really receives after being away too long.
    sent.length = 0;
    for (let i = 0; i < 520; i++) {
      hub.publishConversation("p-2", "claude", { kind: "turn", turn: { turnId: `t-${i}`, startedAt: now } });
    }
    hub.handleMessage(conn, JSON.stringify({
      type: "conversation.resume",
      cursors: [{ paneId: "p-2", cursor: 1 }],
    }));
    const truncated = sent.find((e) => e.type === "conversation.truncated");
    assertFixture("stream-conversation-truncated", truncated);
    for (const type of [
      "hello",
      "fleet.changed",
      "cell.output",
      "cell.truncated",
      "notification",
      "conversation",
    ]) {
      assertFixture(`stream-${type.replace(".", "-")}`, byType.get(type as ServerEvent["type"]));
    }
  });

  /**
   * The VPS `hello`, and the reason it has its own fixture: it is the frame that
   * tells the app to draw Terminal only (§7 no. 10). Same shape as the desktop
   * one, two fewer features — and the app decides the screen from that, instead of
   * opening Chat and finding it permanently empty.
   *
   * This is the **bare** VPS: no Codex, no agent hook. Fase 3 did not change it, and that is
   * the point of keeping it — a host that cannot name a runner's transcript file still says so.
   */
  it("stream-hello-standalone matches what a VPS host announces", () => {
    const sent: ServerEvent[] = [];
    const hub = new StreamHub({ host: { ...HOST, hostId: "vps", hostLabel: "VPS", mode: "standalone" } });
    hub.attach({ send: (d) => sent.push(JSON.parse(d) as ServerEvent), close: () => undefined },
      devices.issue("iPhone"));

    assertFixture("stream-hello-standalone", sent[0]);
  });

  /**
   * The VPS as it actually runs, which the bare fixture above no longer describes.
   *
   * A standalone host installs the agent hook itself on startup, and as of Fase 3 that hook is
   * what buys all three Chat capabilities: it reports `transcript_path`, so the host knows which
   * file to read (`transcript`, `conversation`), and it reports the turn, so a prompt can be told
   * from output printed ten minutes ago (`permission`, ADR-8).
   *
   * Its own fixture because the difference is what a phone decides its screens from: with this
   * frame the app draws Chat against a machine that has no desktop behind it at all.
   */
  it("stream-hello-standalone-hooked matches a VPS host whose agent hook is installed", () => {
    const sent: ServerEvent[] = [];
    const hub = new StreamHub({
      host: { ...HOST, hostId: "vps", hostLabel: "VPS", mode: "standalone" },
      hooks: true,
      // Not tied to the hook, and named here so nobody reads it that way: this fixture is
      // *the VPS as it actually runs*, and a standalone host defaults its workspace root to
      // `~/lotus-workspaces` (`server/index.ts`). The bare fixture above keeps it off,
      // because a host configured with a fixed `PROJECTS_JSON` list has nowhere to clone to.
      projectsCreate: true,
      // Same reasoning, second flag: a real VPS has a workspace root, and the workspace root
      // is always open for browsing even before the operator names any `LOTUS_BROWSE_ROOTS`.
      projectsBrowse: true,
    });
    hub.attach({ send: (d) => sent.push(JSON.parse(d) as ServerEvent), close: () => undefined },
      devices.issue("iPhone"));

    assertFixture("stream-hello-standalone-hooked", sent[0]);
  });

  // `hello` and `POST /m/pair` both advertise capabilities, and they drifted: the
  // routes list grew, `stream-hub`'s copy did not, and every unit test still passed
  // because each checked its own copy. ADR-10 makes `hello` authoritative, so the
  // stale one was the one clients would trust.
  it("advertises the same capabilities on hello and on pair", () => {
    const hello = JSON.parse(
      readFileSync(join(FIXTURES, "stream-hello.json"), "utf8"),
    ) as { hostCaps: { features: string[] } };
    const pair = JSON.parse(
      readFileSync(join(FIXTURES, "rest-pair.json"), "utf8"),
    ) as { hostCaps: { features: string[] } };

    expect([...hello.hostCaps.features].sort()).toEqual([...pair.hostCaps.features].sort());
  });

  // The same drift, one mode over: `hello` and `/m/pair` now answer differently
  // per mode, so the two paths have twice the room to disagree. Generated in
  // process rather than read from fixtures, because a standalone `pair` has no
  // fixture and a test that only compares committed files cannot see this.
  it("keeps hello and pair in step on a standalone host too", async () => {
    const standalone = { hostId: "vps", hostLabel: "VPS", mode: "standalone" } as const;
    const sent: ServerEvent[] = [];
    new StreamHub({ host: standalone }).attach(
      { send: (d) => sent.push(JSON.parse(d) as ServerEvent), close: () => undefined },
      devices.issue("iPhone"),
    );
    const router = buildMobileRouter({
      api: {} as MobileRouterDeps["api"],
      devices,
      pairing,
      host: standalone,
      audit: () => undefined,
      fleetSnapshot: async () => [],
    });
    const { code } = pairing.create();
    const paired = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });

    const hello = sent[0] as { hostCaps: { features: string[] } };
    const pair = paired.json as { hostCaps: { features: string[] } };
    expect([...hello.hostCaps.features].sort()).toEqual([...pair.hostCaps.features].sort());
    expect(hello.hostCaps.features).not.toContain("transcript");
  });

  /**
   * Every `ServerEvent` variant has a fixture — enforced by the **compiler**, not by a second
   * hand-written list.
   *
   * It used to be two hardcoded arrays compared against each other, which is a test that can
   * only ever pass: `conversation` was added to the union and shipped with no fixture while
   * this still went green. The `Record` below is exhaustive over `ServerEvent["type"]`, so a
   * new variant fails to compile until it is named here, and the assertion then checks that a
   * fixture for it actually exists on disk.
   */
  it("covers every ServerEvent variant, so a new one cannot ship undocumented", () => {
    const fixtureFor: Record<ServerEvent["type"], string> = {
      hello: "stream-hello",
      "fleet.changed": "stream-fleet-changed",
      "cell.output": "stream-cell-output",
      "cell.truncated": "stream-cell-truncated",
      notification: "stream-notification",
      conversation: "stream-conversation",
      "conversation.truncated": "stream-conversation-truncated",
    };

    const missing = Object.values(fixtureFor).filter(
      (name) => !existsSync(join(FIXTURES, `${name}.json`)),
    );
    expect(missing).toEqual([]);
  });
});
