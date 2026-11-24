import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { DetectedCli } from "@/lib/tauri-api";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import type { CanvasSessionRecord } from "../../session-record";
import {
  SHEET_AUTO_OPEN_MIN_CHARS,
  SHEET_BROWSE_GROUP_LIMIT,
  SHEET_SEARCH_LIMIT,
  isBrowseMode,
  scoreSheetMatch,
  buildCommandSheetItems,
  buildSendRow,
  filterCommandSheetItems,
  matchesSheetQuery,
  shouldAutoOpenSheet,
  type CommandSheetInput,
  type SheetItem,
} from "../command-sheet-items";

/**
 * These assertions moved here from CanvasCommandPalette.test.tsx when ⌘K merged into the NL command
 * bar. They were always about the CATALOG — what rows exist, what they run, in what order — and the
 * palette's DOM was only the harness they happened to be driven through. Testing the pure builder
 * instead means they no longer depend on a search input existing, which is precisely the thing the
 * merge deleted.
 */

const CLIS: DetectedCli[] = [
  { id: "claude", name: "Claude Code", command: "claude", installed: true },
  { id: "cursor", name: "Cursor Agent", command: "cursor-agent", installed: true },
] as DetectedCli[];

function build(overrides: Partial<CommandSheetInput> = {}): SheetItem[] {
  return buildCommandSheetItems({ nodes: [], clis: [], ...overrides });
}

const byId = (items: SheetItem[], id: string) => items.find((i) => i.id === id);
const titled = (items: SheetItem[], re: RegExp) => items.find((i) => re.test(i.title));

function project(overrides: Partial<CodeCanvasProjectMeta> & { id: string }): CodeCanvasProjectMeta {
  return { rootDir: `/repos/${overrides.id}`, alias: null, position: 0, updatedAt: 0, lastOpenedAt: 0, ...overrides };
}

function node(overrides: Partial<Node> & { id: string }): Node {
  return { position: { x: 0, y: 0 }, data: {}, ...overrides } as Node;
}

describe("command sheet catalog", () => {
  it("offers create rows that run the canonical create-node command", () => {
    const item = byId(build(), "create-task");
    expect(item?.action).toEqual({ kind: "command", command: { kind: "create-node", nodeType: "task" } });
    expect(item?.tag).toBe("ADD");
  });

  it("launches a detected CLI as an auto-named live agent (runner-first, ADR-0027)", () => {
    const item = titled(build({ clis: CLIS }), /Launch Cursor Agent/);
    expect(item?.tag).toBe("AGENT");
    expect(item?.action.kind).toBe("command");
    const command = item?.action.kind === "command" ? item.action.command : null;
    expect(command).toMatchObject({ kind: "create-agent" });
    if (command?.kind !== "create-agent") throw new Error("expected create-agent");
    expect(command.definition.runner).toBe("cursor");
    expect(command.definition.name).toBeTruthy(); // auto-named
  });

  it("launches a custom runner through the `custom` runner, carrying its command", () => {
    // A custom runner reaches the catalog already adapted to the DetectedCli shape, so it spawns
    // down the identical path — its non-native id is what routes it to the `custom` runner.
    const custom = { id: "my-runner", name: "My Runner", command: "my-cli --flag", installed: true } as DetectedCli;
    const item = titled(build({ clis: [custom] }), /Launch My Runner/);
    if (item?.action.kind !== "command" || item.action.command.kind !== "create-agent") {
      throw new Error("expected a create-agent command");
    }
    expect(item.action.command.definition.runner).toBe("custom");
    expect(item.action.command.definition.runnerCommand).toBe("my-cli --flag");
  });

  it("puts launch rows first — launching is the sheet's primary action", () => {
    const items = build({ clis: CLIS });
    expect(items[0]?.group).toBe("launch");
  });

  it("offers a focus row for every existing node, tagged as navigation", () => {
    const items = build({ nodes: [node({ id: "n1", type: "note", data: { title: "Spec" } })] });
    const item = byId(items, "focus-n1");
    expect(item?.title).toBe("Focus Spec");
    expect(item?.tag).toBe("GO");
    expect(item?.action).toEqual({ kind: "command", command: { kind: "focus-node", nodeId: "n1" } });
  });

  it("exposes task dispatch for a selected task node, single and team", () => {
    const items = build({ nodes: [node({ id: "t1", type: "task", selected: true, data: { title: "Ship it" } })] });
    expect(byId(items, "dispatch-selected-single-t1")?.action).toEqual({
      kind: "command",
      command: { kind: "dispatch-task", nodeId: "t1", mode: "single" },
    });
    expect(byId(items, "dispatch-selected-team-t1")?.action).toEqual({
      kind: "command",
      command: { kind: "dispatch-task", nodeId: "t1", mode: "team" },
    });
  });

  it("exposes recovery for a selected browser and a selected terminal", () => {
    const browser = build({ nodes: [node({ id: "b1", type: "browser", selected: true, data: { url: "https://x" } })] });
    expect(byId(browser, "recover-browser-b1")?.action).toEqual({
      kind: "command",
      command: { kind: "recover-browser", nodeId: "b1" },
    });
    const term = build({ nodes: [node({ id: "s1", type: "terminal", selected: true, data: { title: "sh" } })] });
    expect(byId(term, "recover-terminal-s1")?.action).toEqual({
      kind: "command",
      command: { kind: "recover-terminal", nodeId: "s1" },
    });
    expect(byId(term, "toggle-browser-s1")?.action).toEqual({
      kind: "command",
      command: { kind: "toggle-browser", terminalId: "s1" },
    });
  });

  it("marks closing a node as destructive so the row can be toned apart", () => {
    const items = build({ nodes: [node({ id: "n1", type: "note", selected: true, data: { title: "Spec" } })] });
    expect(byId(items, "close-selected-n1")?.tone).toBe("danger");
  });

  it("routes app actions through their callbacks and tags them APP, not GO", () => {
    const onOpenSettings = vi.fn();
    const onOpenCanvases = vi.fn();
    const items = build({ onOpenSettings, onOpenCanvases });
    const settings = byId(items, "open-settings");
    // The tag split is the reason it is authored per row rather than derived from the group: both
    // of these sit in "Go to", but one changes the app and the other moves the camera.
    expect(settings?.tag).toBe("APP");
    if (settings?.action.kind !== "custom") throw new Error("expected a custom action");
    settings.action.run();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(byId(items, "open-canvases")?.tag).toBe("APP");
  });

  it("offers one Stop All Speech row that silences every voice (Lotus #176)", () => {
    expect(byId(build(), "stop-all-speech")).toBeUndefined();
    const onStopAllSpeech = vi.fn();
    const row = byId(build({ onStopAllSpeech }), "stop-all-speech");
    expect(row?.tag).toBe("APP");
    expect(matchesSheetQuery(row!, "silence")).toBe(true);
    if (row?.action.kind !== "custom") throw new Error("expected a custom action");
    row.action.run();
    expect(onStopAllSpeech).toHaveBeenCalledOnce();
  });

  it("offers a switch row for every project except the active one", () => {
    const items = build({
      projects: [project({ id: "a" }), project({ id: "b" }), project({ id: "c" })],
      activeProjectId: "b",
      onSelectProject: vi.fn(),
    });
    const ids = items.filter((i) => i.id.startsWith("switch-project-")).map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("switch-project-b");
  });

  it("runs onSelectProject with the project id when a switch row is chosen", () => {
    const onSelectProject = vi.fn();
    const items = build({ projects: [project({ id: "a" })], activeProjectId: null, onSelectProject });
    const row = byId(items, "switch-project-a");
    if (row?.action.kind !== "custom") throw new Error("expected a custom action");
    row.action.run();
    expect(onSelectProject).toHaveBeenCalledWith("a");
  });

  it("orders recent projects (most-recently-opened first) before the rest", () => {
    const items = build({
      projects: [
        project({ id: "cold" }),
        project({ id: "warm", lastOpenedAt: 100 }),
        project({ id: "hot", lastOpenedAt: 900 }),
      ],
      activeProjectId: null,
      onSelectProject: vi.fn(),
    });
    const order = items.filter((i) => i.id.startsWith("switch-project-")).map((i) => i.id);
    expect(order.slice(0, 2)).toEqual(["switch-project-hot", "switch-project-warm"]);
  });

  it("names a switch row by root-dir basename when no alias is set", () => {
    const items = build({
      projects: [project({ id: "a", rootDir: "/repos/lotus-core" })],
      activeProjectId: null,
      onSelectProject: vi.fn(),
    });
    expect(byId(items, "switch-project-a")?.title).toBe("Switch to lotus-core");
  });

  it("adds no switch rows when no projects are given (back-compat)", () => {
    expect(build().some((i) => i.id.startsWith("switch-project-"))).toBe(false);
  });
});

describe("command sheet filtering", () => {
  it("requires every whitespace-separated part of the query to match", () => {
    const items = build({ nodes: [], clis: CLIS });
    const claude = titled(items, /Launch Claude Code/)!;
    expect(matchesSheetQuery(claude, "launch claude")).toBe(true);
    expect(matchesSheetQuery(claude, "launch cursor")).toBe(false);
  });

  it("lists the Dock's apps as rows, not chords, and only when the host can open them", () => {
    expect(byId(build(), "open-automation")).toBeUndefined();
    const onOpenAutomation = vi.fn();
    const onOpenFleet = vi.fn();
    const items = build({ onOpenAutomation, onOpenFleet });
    const automation = byId(items, "open-automation")!;
    expect(matchesSheetQuery(automation, "inbox")).toBe(true);
    expect(automation.action).toEqual({ kind: "custom", run: onOpenAutomation });
    expect(byId(items, "open-fleet")!.action).toEqual({ kind: "custom", run: onOpenFleet });
  });

  it("offers New Factory run… as an app row, only when the host can open it", () => {
    expect(byId(build(), "new-factory-run")).toBeUndefined();
    const onNewFactoryRun = vi.fn();
    const row = byId(build({ onNewFactoryRun }), "new-factory-run")!;
    expect(row.tag).toBe("APP");
    expect(row.action).toEqual({ kind: "custom", run: onNewFactoryRun });
  });

  it("offers a run that waits for you by its verb, even on the board, and opens it in the Dock", () => {
    const waiting = { repo: "o/r", issue: 7, title: "Fix login", statusWord: "Needs you", next: "Answer" };
    const working = { repo: "o/r", issue: 8, title: "Add docs", statusWord: "Working", next: "" };
    const onOpenFactoryRun = vi.fn();
    const onBoard = [{ id: "f1", type: "factory", position: { x: 0, y: 0 }, data: { repo: "o/r", issue: 7, title: "Fix login" } }] as Node[];
    const items = build({ nodes: onBoard, factoryRuns: [waiting, working], onOpenFactoryRun, onAddFactoryRun: vi.fn() });
    const row = byId(items, "factory-next-o/r#7")!;
    expect(row.title).toBe("Answer: #7 Fix login");
    expect(byId(items, "factory-next-o/r#8")).toBeUndefined();
    // Already on the board, so not offered to place again — but still offered to answer.
    expect(byId(items, "factory-o/r#7")).toBeUndefined();
    (row.action as { run: () => void }).run();
    expect(onOpenFactoryRun).toHaveBeenCalledWith(waiting);
  });

  it("matches on keywords, not only the visible title", () => {
    const settings = byId(build({ onOpenSettings: vi.fn() }), "open-settings")!;
    expect(settings.title).not.toMatch(/preferences/i);
    expect(matchesSheetQuery(settings, "preferences")).toBe(true);
  });

  it("appends the send row last, and only when something was typed", () => {
    const catalog = build();
    const empty = filterCommandSheetItems(catalog, "", vi.fn());
    expect(empty.some((i) => i.group === "send")).toBe(false);

    const typed = filterCommandSheetItems(catalog, "note", vi.fn());
    expect(typed[typed.length - 1]?.group).toBe("send");
    expect(typed[typed.length - 1]?.tag).toBe("SEND");
  });

  it("keeps the send row even when nothing in the catalog matches", () => {
    // The whole point: the sheet must never stand between the user and the NL pipeline. A query the
    // catalog knows nothing about is the most likely thing to be free-form prose.
    const rows = filterCommandSheetItems(build(), "tolong rapikan node yang berantakan", vi.fn());
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toBe("send");
  });

  it("quotes the user's own words in the send row and runs the pipeline verbatim", () => {
    const onSend = vi.fn();
    const row = buildSendRow("  open codex  ", onSend)!;
    expect(row.title).toContain("open codex");
    expect(row.title).not.toContain("  open");
    if (row.action.kind !== "custom") throw new Error("expected a custom action");
    row.action.run();
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("has no send row for a whitespace-only query", () => {
    expect(buildSendRow("   ", vi.fn())).toBeNull();
  });
});

describe("hybrid auto-open rule", () => {
  const catalog = build({ clis: CLIS, onOpenSettings: vi.fn() });

  it("stays shut below the character floor, even on a matching prefix", () => {
    // "l" matches Launch rows, but a panel on the first keystroke of every sentence is the failure
    // this floor exists to prevent.
    expect(SHEET_AUTO_OPEN_MIN_CHARS).toBe(2);
    expect(shouldAutoOpenSheet(catalog, "l")).toBe(false);
  });

  it("opens once the query is long enough AND the catalog has a match", () => {
    expect(shouldAutoOpenSheet(catalog, "la")).toBe(true);
    expect(shouldAutoOpenSheet(catalog, "launch cur")).toBe(true);
  });

  it("stays shut for free-form prose the catalog knows nothing about", () => {
    // Dictation produces exactly this, at length, and it must not hold a panel open while the user
    // is still talking.
    expect(shouldAutoOpenSheet(catalog, "tolong rapikan node yang berantakan itu")).toBe(false);
  });

  it("ignores the send row when deciding — it matches everything", () => {
    // shouldAutoOpenSheet takes the CATALOG, not the rendered rows. Handing it a list that already
    // contains the send row would make the rule vacuously true for any 2+ character query.
    const withSend = filterCommandSheetItems(catalog, "zzzz", vi.fn());
    expect(withSend.some((i) => i.group === "send")).toBe(true);
    expect(shouldAutoOpenSheet(catalog, "zzzz")).toBe(false);
  });
});

describe("shared vocabulary with the NL fast path", () => {
  it("finds a Launch row by every spawn verb the bar's fast path accepts", () => {
    // The gap this closes was visible the first time the sheet was rendered: typing "open" showed
    // no agent at all, while "open codex" in the same bar fast-pathed straight to a spawn. Two
    // doors onto one engine, disagreeing about the words.
    const item = titled(build({ clis: CLIS }), /Launch Codex|Launch Cursor Agent/)!;
    for (const verb of ["open", "launch", "spawn", "start", "run", "buka", "jalankan", "bikin"]) {
      expect(matchesSheetQuery(item, `${verb} cursor`), `verb "${verb}" did not match`).toBe(true);
    }
  });

  it("offers one Claude row whose account ⇥ cycles, and only Claude (decision 6)", () => {
    const onCycleAccount = vi.fn();
    const plain = byId(build({ clis: CLIS, claudeAccounts: ["hss"], onCycleAccount }), "launch-claude")!;
    expect(plain.action.kind === "command" && "options" in plain.action.command).toBe(false);
    expect(plain.account).toBeNull();
    plain.cycle!();
    expect(onCycleAccount).toHaveBeenCalled();

    const items = build({ clis: CLIS, claudeAccounts: ["hss"], launchAccount: "hss", onCycleAccount });
    const hss = byId(items, "launch-claude")!;
    expect(hss.account).toBe("hss");
    expect(hss.action).toMatchObject({ kind: "command", command: { kind: "create-agent", options: { account: "hss" } } });
    expect(byId(items, "launch-claude-hss")).toBeUndefined();
    expect(byId(items, "launch-cursor")!.cycle).toBeUndefined();
  });

  it("keeps the sheet's Launch rows searchable in Indonesian, like the fast path", () => {
    const item = titled(build({ clis: CLIS }), /Launch Claude Code/)!;
    expect(matchesSheetQuery(item, "buka claude")).toBe(true);
  });
});

describe("relevance ranking", () => {
  // Eight CLIs is a realistic install, and the flood this describes was seen in the running app.
  const MANY: DetectedCli[] = ["claude", "codex", "cursor", "grok", "hss", "pi", "acme"].map(
    (id) => ({ id, name: id, command: id, installed: true }) as DetectedCli,
  );
  const catalog = () =>
    build({
      clis: MANY,
      onOpenSettings: vi.fn(),
      onOpenCanvases: vi.fn(),
      projects: [project({ id: "terax-ai" }), project({ id: "codespace-demo" })],
      activeProjectId: null,
      onSelectProject: vi.fn(),
    });

  it("ranks a visible title match above a keyword-only match", () => {
    // "open" reaches the Launch rows only through the shared spawn-verb index, which is invisible;
    // it is in "Open Canvas Settings" in plain sight. The screenshot that prompted this showed
    // eight indistinguishable Launch rows above everything, which is the inverse.
    const rows = filterCommandSheetItems(catalog(), "open", vi.fn());
    expect(rows[0].title).toBe("Open Canvas Settings");
    const firstLaunch = rows.findIndex((r) => r.group === "launch");
    expect(firstLaunch).toBeGreaterThan(0);
  });

  it("caps the ranked list so the sheet stays a shortcut, not a wall", () => {
    const rows = filterCommandSheetItems(catalog(), "open", vi.fn());
    // The cap is the sheet's own visible height expressed as a count, plus the pinned send row.
    expect(rows).toHaveLength(SHEET_SEARCH_LIMIT + 1);
    expect(rows[rows.length - 1].group).toBe("send");
  });

  it("still puts the right agent first once the query names one", () => {
    // Sharing the fast path's verbs must keep paying off: "open codex" is a title word match.
    const rows = filterCommandSheetItems(catalog(), "open codex", vi.fn());
    expect(rows[0].title).toMatch(/codex/i);
  });

  it("scores a title prefix above a word-boundary match above a detail match", () => {
    const items = catalog();
    const settings = byId(items, "open-settings")!;      // title starts with "Open"
    const browser = byId(items, "create-browser")!;      // detail: "Open a standalone browser node"
    expect(scoreSheetMatch(settings, "open")!).toBeGreaterThan(scoreSheetMatch(browser, "open")!);
  });

  it("returns null for an item the query does not match at all", () => {
    expect(scoreSheetMatch(byId(build(), "create-task")!, "zzzz")).toBeNull();
  });

  it("lets the group prior break a tie but never overturn a tier", () => {
    const items = catalog();
    const launch = titled(items, /Launch codex/i)!;   // keyword-only for "open" → tier 0
    const settings = byId(items, "open-settings")!;   // title prefix → tier 40
    expect(scoreSheetMatch(launch, "open")!).toBeLessThan(scoreSheetMatch(settings, "open")!);
  });

  it("browses in curated group order with each group capped", () => {
    // ⌘K with nothing typed is a browse, not a search: sections stay, but "Focus <node>" alone
    // could otherwise contribute 40 rows.
    const nodes = Array.from({ length: 20 }, (_, i) => node({ id: `n${i}`, type: "note" }));
    const rows = filterCommandSheetItems(build({ clis: MANY, nodes }), "", vi.fn());
    const perGroup = new Map<string, number>();
    for (const r of rows) perGroup.set(r.group, (perGroup.get(r.group) ?? 0) + 1);
    for (const [group, count] of perGroup) {
      expect(count, `${group} exceeded the browse cap`).toBeLessThanOrEqual(SHEET_BROWSE_GROUP_LIMIT);
    }
    // Curated order is preserved: launch first.
    expect(rows[0].group).toBe("launch");
    // No send row for an empty query.
    expect(rows.some((r) => r.group === "send")).toBe(false);
  });

  it("reports which mode a query produces, so the sheet knows whether to draw headings", () => {
    expect(isBrowseMode("")).toBe(true);
    expect(isBrowseMode("   ")).toBe(true);
    expect(isBrowseMode("open")).toBe(false);
  });
});

// ── Session rows (plans/codecanvas-session-widget/, Slice 02) ────────────────────────────────────

function sessionRecord(
  overrides: Partial<CanvasSessionRecord> & { id: string },
): CanvasSessionRecord {
  return {
    projectId: "cp_1",
    nodeId: "agent-1",
    runner: "claude",
    cwd: "/repos/demo",
    title: "Transcript route",
    status: "resumable",
    origin: "manual",
    turnCount: 4,
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("session rows", () => {
  /** A canvas where every session's node is mounted, awake, and in some other conversation. */
  const onBoard = {
    projectId: "cp_1",
    isRegistered: () => true,
    isDormant: () => false,
    activeSessionId: () => null,
  };

  it("adds one row per session", () => {
    const items = build({
      nodes: [node({ id: "agent-1", type: "agent", data: { name: "Rowan" } })],
      sessions: [sessionRecord({ id: "s1" })],
      sessionBoard: onBoard,
      onDispatchSession: vi.fn(),
    });
    const row = byId(items, "resume-session-s1");
    expect(row).toBeDefined();
    expect(row?.title).toContain("Rowan");
    expect(row?.title).toContain("Transcript route");
    expect(row?.group).toBe("navigate");
  });

  // It used to be skipped, which is exactly the ghost-row bug seen from the palette: the session
  // exists, it can be run, and the list pretended it did not exist
  // (`plans/codecanvas-session-refactor/issues/03`).
  it("offers to attach a session whose node is not on this canvas", () => {
    const items = build({
      nodes: [],
      sessions: [sessionRecord({ id: "s1" })],
      sessionBoard: { ...onBoard, isRegistered: () => false },
      onDispatchSession: vi.fn(),
    });
    expect(byId(items, "resume-session-s1")?.title.startsWith("Open ")).toBe(true);
  });

  it("offers to attach a session that has been detached from every node", () => {
    const items = build({
      nodes: [node({ id: "agent-1", type: "agent", data: { name: "Rowan" } })],
      sessions: [sessionRecord({ id: "s1", nodeId: null })],
      sessionBoard: onBoard,
      onDispatchSession: vi.fn(),
    });
    expect(byId(items, "resume-session-s1")?.title.startsWith("Open ")).toBe(true);
  });

  // A running conversation already has a CLI. Resuming it would hand the user a second one.
  it("says Open for a running conversation and for a stored one alike", () => {
    const nodes = [node({ id: "agent-1", type: "agent", data: { name: "Rowan" } })];
    const live = build({
      nodes,
      sessions: [sessionRecord({ id: "s1", status: "live" })],
      sessionBoard: { ...onBoard, activeSessionId: () => "s1" },
      onDispatchSession: vi.fn(),
    });
    expect(byId(live, "resume-session-s1")?.title.startsWith("Open ")).toBe(true);

    const saved = build({
      nodes,
      sessions: [sessionRecord({ id: "s1" })],
      sessionBoard: onBoard,
      onDispatchSession: vi.fn(),
    });
    expect(byId(saved, "resume-session-s1")?.title.startsWith("Open ")).toBe(true);
  });

  it("hands every row to the one dispatcher", () => {
    const onDispatchSession = vi.fn();
    const nodes = [node({ id: "agent-1", type: "agent", data: { name: "Rowan" } })];
    const saved = sessionRecord({ id: "s1" });

    const items = build({ nodes, sessions: [saved], sessionBoard: onBoard, onDispatchSession });
    const action = byId(items, "resume-session-s1")?.action;
    if (action?.kind === "custom") action.run();

    expect(onDispatchSession).toHaveBeenCalledWith(saved);
  });

  // A conversation the CLI has lost cannot be resumed, and it is not running to be focused.
  it("skips a dead session entirely", () => {
    const items = build({
      nodes: [node({ id: "agent-1", type: "agent", data: { name: "Rowan" } })],
      sessions: [sessionRecord({ id: "s1", status: "dead" })],
      sessionBoard: onBoard,
      onDispatchSession: vi.fn(),
    });
    expect(byId(items, "resume-session-s1")).toBeUndefined();
  });

  it("contributes no rows when there are no sessions or no handler", () => {
    const nodes = [node({ id: "agent-1", type: "agent", data: { name: "Rowan" } })];
    expect(
      build({ nodes, sessions: [], sessionBoard: onBoard, onDispatchSession: vi.fn() }).some((i) =>
        i.id.startsWith("resume-session-"),
      ),
    ).toBe(false);
    expect(
      build({ nodes, sessions: [sessionRecord({ id: "s1" })] }).some((i) =>
        i.id.startsWith("resume-session-"),
      ),
    ).toBe(false);
  });

  it("is findable by the words someone would type", () => {
    const items = build({
      nodes: [node({ id: "agent-1", type: "agent", data: { name: "Rowan" } })],
      sessions: [sessionRecord({ id: "s1" })],
      sessionBoard: onBoard,
      onDispatchSession: vi.fn(),
    });
    const row = byId(items, "resume-session-s1");
    expect(row?.keywords).toMatch(/sesi/);
    expect(row?.keywords).toMatch(/Rowan/);
    expect(row?.keywords).toMatch(/claude/);
  });
});

describe("New Run from Selection", () => {
  const node = (id: string, type: string, extra: Partial<Node> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data: {}, ...extra });

  it("offers a run over the selected runnable nodes only", () => {
    const items = build({ nodes: [node("a", "agent", { selected: true }), node("n", "note", { selected: true }), node("b", "agent")] });
    expect(byId(items, "create-run-from-selection")?.action).toEqual({ kind: "command", command: { kind: "create-run", memberIds: ["a"] } });
  });

  it("is absent when nothing selected can join a run", () => {
    expect(byId(build({ nodes: [node("n", "note", { selected: true })] }), "create-run-from-selection")).toBeUndefined();
    const owned = [node("r", "run", { data: { memberIds: ["a"] } }), node("a", "agent", { selected: true })];
    expect(byId(build({ nodes: owned }), "create-run-from-selection")).toBeUndefined();
  });
});
