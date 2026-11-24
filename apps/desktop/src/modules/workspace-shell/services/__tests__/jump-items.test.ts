import { beforeEach, describe, expect, it } from "vitest";
import type { ChatThread } from "@/modules/chat/runtime/chat-runtime-client";
import type { RailPane } from "../../types";
import { buildJumpItems, emptyJumpList, jumpAge, oldestNeedsYou, searchJumpList, type JumpSources } from "../jump-items";
import { notePaneAsk, paneAsks, resetPaneAsksForTest } from "../pane-asks";
import { newNeedsYouAlerts } from "../../hooks/useNeedsYouAlerts";
import { readRecent, touchRecent } from "../jump-recent";

const thread = (id: string, over: Partial<ChatThread> = {}): ChatThread => ({
  id,
  cwd: "/w/lotus",
  model: null,
  permissionMode: "default",
  runner: "claude",
  provider: null,
  effort: null,
  providerSessionId: null,
  account: null,
  createdAt: 0,
  updatedAt: 0,
  title: id,
  importedFrom: null,
  archived: false,
  pinnedAt: null,
  lastTurnEndedAt: null,
  lastReadAt: null,
  turnStartedAt: null,
  status: null,
  parentId: null,
  ...over,
});
const pane = (id: string, over: Partial<RailPane> = {}): RailPane => ({ id, kind: "terminal", title: id, meta: "", ...over });

const sources = (over: Partial<JumpSources> = {}): JumpSources => ({
  workspaces: [
    { id: "w1", name: "Lotus", folder: "/w/lotus", panes: [pane("nia", { persona: "Nia", title: "claude", activity: "needs-you" }), pane("chatpane", { kind: "thread", title: "Review notes" })] },
    { id: "w2", name: "host-dev", folder: "/srv/host", host: "devbox-vps", panes: [pane("lyra", { persona: "Lyra", title: "codex", activity: "working" })] },
  ],
  threads: [thread("Orca research", { updatedAt: 500 }), thread("Review notes"), thread("Deploy", { status: "waiting", updatedAt: 10 })],
  threadInPane: new Map([["chatpane", "Review notes"]]),
  recent: { w1: 900, chatpane: 800 },
  ...over,
});

describe("Jump palette list", () => {
  it("lists Needs you (waiting longest first), then what works, then recent; no modes when empty", () => {
    const list = emptyJumpList(buildJumpItems(sources()));
    expect(list.map((i) => i.title)).toEqual(["Nia · claude", "Deploy", "Lyra · codex", "Lotus", "Review notes", "Orca research"]);
  });

  it("puts Factory and Automation asks in Waiting, failed panes too, and Done newest first", () => {
    const open = () => undefined;
    const items = buildJumpItems(
      sources({
        workspaces: [
          {
            id: "w1",
            name: "Lotus",
            folder: "/w/lotus",
            panes: [
              pane("nia", { title: "nia", activity: "needs-you", activitySince: 50 }),
              pane("bad", { title: "bad", activity: "failed", activitySince: 5 }),
              pane("old", { title: "old", activity: "idle", unread: true, activitySince: 1 }),
              pane("new", { title: "new", activity: "idle", unread: true, activitySince: 9 }),
            ],
          },
        ],
        threads: [],
        asks: [{ id: "automation:a", source: "automation", name: "PR review #318", line: "Asks you a question", askedAtMs: 20, onOpen: open }],
        paneAsks: new Map([["nia", "Allow Bash: rm -rf dist?"]]),
      }),
    );
    const needs = emptyJumpList(items).filter((i) => i.status === "waiting" || i.status === "done");
    expect(needs.map((i) => [i.title, i.status, i.detail])).toEqual([
      ["bad", "waiting", "Failed"],
      ["PR review #318", "waiting", "Asks you a question"],
      ["nia", "waiting", "Allow Bash: rm -rf dist?"],
      ["new", "done", undefined],
      ["old", "done", undefined],
    ]);
    expect(items.find((i) => i.title === "PR review #318")!.target).toEqual({ kind: "ask", open });
    expect(oldestNeedsYou(items)!.title).toBe("bad");
    expect(oldestNeedsYou(items.filter((i) => i.status !== "waiting"))!.title).toBe("old");
  });

  it("keeps a waiting pane's question until its agent moves on; SSH drops carry none", () => {
    resetPaneAsksForTest();
    notePaneAsk({ paneId: "nia", status: "needs-input", body: "Allow Bash?" });
    notePaneAsk({ paneId: "kai", status: "needs-input", body: "" });
    expect([...paneAsks()]).toEqual([["nia", "Allow Bash?"]]);
    notePaneAsk({ paneId: "nia", status: "running", body: "" });
    expect(paneAsks().size).toBe(0);
  });

  it("announces only what is new, Waiting by default and Done when switched on", () => {
    const items = buildJumpItems(sources({ workspaces: [{ id: "w", name: "W", folder: "/w", panes: [pane("a", { activity: "needs-you" }), pane("b", { activity: "idle", unread: true })] }], threads: [] }));
    expect(newNeedsYouAlerts(new Set(), items, { needsInput: true, done: false }).map((i) => i.id)).toEqual(["pane:a"]);
    expect(newNeedsYouAlerts(new Set(["pane:a"]), items, { needsInput: true, done: true }).map((i) => i.id)).toEqual(["pane:b"]);
  });

  it("shows a thread that lives in a pane once, as that pane", () => {
    const items = buildJumpItems(sources());
    const review = items.filter((i) => i.title === "Review notes");
    expect(review).toHaveLength(1);
    expect(review[0]!.target).toEqual({ kind: "pane", paneId: "chatpane" });
  });

  it("finds by word across title, place, host and agent, and offers modes", () => {
    const items = buildJumpItems(sources());
    expect(searchJumpList(items, "vps")[0]!.title).toBe("host-dev");
    expect(searchJumpList(items, "lyra")[0]!.target).toEqual({ kind: "pane", paneId: "lyra" });
    expect(searchJumpList(items, "canv")[0]!.target).toEqual({ kind: "mode", mode: "canvas" });
    expect(searchJumpList(items, "zzz")).toEqual([]);
  });

  it("says a short age", () => {
    expect(jumpAge(0, 1)).toBe("");
    expect(jumpAge(1000, 1000)).toBe("now");
    expect(jumpAge(0 + 1, 5 * 60_000 + 1)).toBe("5m");
  });
});

describe("jump recent", () => {
  beforeEach(() => localStorage.clear());
  it("keeps the latest use per id", () => {
    touchRecent(["a", null, "b"], 5);
    touchRecent(["a"], 9);
    expect(readRecent()).toEqual({ a: 9, b: 5 });
  });
});
