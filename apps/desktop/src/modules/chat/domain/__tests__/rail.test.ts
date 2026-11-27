import { describe, expect, it } from "vitest";

import type { ChatThread } from "../../runtime/chat-runtime-client";
import { agentsLine, chatTabMark, displayTitle, isVerifier, placeName, railChildren, railDescendants, railGroups, railSections, shortSince, sinceLabel, statsLine, verifyLabel, visibleChildren } from "../rail";

const thread = (id: string, cwd: string): ChatThread => ({
  id,
  cwd,
  model: null,
  permissionMode: "default",
  runner: "claude",
  provider: null,
  effort: null,
  providerSessionId: null,
  account: null,
  createdAt: 0,
  updatedAt: 0,
  title: null,
  importedFrom: null,
  archived: false,
  pinnedAt: null,
  lastTurnEndedAt: null,
  lastReadAt: null,
  turnStartedAt: null,
  status: null,
  parentId: null,
});

const ids = (sections: ReturnType<typeof railSections>) => sections.map((s) => [s.id, s.threads.map((t) => t.thread.id)]);

describe("rail", () => {
  it("groups threads by folder, keeping the newest-first order", () => {
    const groups = railGroups([thread("a", "/w/web"), thread("b", "/w/lotus"), thread("c", "/w/web")]);
    expect(groups.map((g) => [g.cwd, g.threads.map((t) => t.id)])).toEqual([
      ["/w/web", ["a", "c"]],
      ["/w/lotus", ["b"]],
    ]);
  });

  it("leaves archived threads out of the folders", () => {
    const groups = railGroups([thread("a", "/w/web"), { ...thread("b", "/w/web"), archived: true }]);
    expect(groups.map((g) => g.threads.map((t) => t.id))).toEqual([["a"]]);
  });

  it("puts news on top, running in the middle, and what you read at the bottom", () => {
    const threads: ChatThread[] = [
      { ...thread("read-new", "/w"), updatedAt: 50, lastTurnEndedAt: 40, lastReadAt: 45 },
      { ...thread("ready-old", "/w"), lastTurnEndedAt: 10 },
      { ...thread("run-a", "/w"), status: "working", turnStartedAt: 1 },
      { ...thread("ready-new", "/w"), lastTurnEndedAt: 30, lastReadAt: 5 },
      { ...thread("waiting", "/w"), status: "waiting" },
      { ...thread("run-b", "/w"), status: "working", turnStartedAt: 2 },
      { ...thread("read-old", "/w"), updatedAt: 20 },
      { ...thread("gone", "/w"), archived: true, lastTurnEndedAt: 99 },
    ];
    expect(ids(railSections(threads, null))).toEqual([
      ["ready", ["waiting", "ready-new", "ready-old"]],
      ["running", ["run-b", "run-a"]],
      ["earlier", ["read-new", "read-old"]],
    ]);
  });

  it("keeps the thread you just opened in Ready, drawn as read, and drops empty sections", () => {
    const opened = { ...thread("a", "/w"), lastTurnEndedAt: 10, lastReadAt: 11 };
    const sections = railSections([opened, { ...thread("b", "/w"), updatedAt: 5 }], "a");
    expect(ids(sections)).toEqual([["ready", ["a"]], ["earlier", ["b"]]]);
    expect(sections[0].threads[0].state).toBe("read");
    expect(ids(railSections([opened], null))).toEqual([["earlier", ["a"]]]);
  });

  it("puts pinned threads first, newest pin on top, each in Pinned only and never moved by activity", () => {
    const threads: ChatThread[] = [
      { ...thread("old-pin", "/w"), pinnedAt: 1, updatedAt: 99 },
      { ...thread("pin-running", "/w"), pinnedAt: 2, status: "working", turnStartedAt: 5 },
      { ...thread("ready", "/w"), lastTurnEndedAt: 10 },
      { ...thread("gone", "/w"), archived: true, pinnedAt: 3 },
    ];
    const sections = railSections(threads, null);
    expect(ids(sections)).toEqual([["pinned", ["pin-running", "old-pin"]], ["ready", ["ready"]]]);
    expect(sections[0].threads[0].state).toBe("running");
  });

  it("says the short time on the right of a row", () => {
    const now = new Date(2026, 9, 29, 15, 0).getTime();
    expect(shortSince(now - 20_000, now)).toBe("now");
    expect(shortSince(now - 12 * 60_000, now)).toBe("12m");
    expect(shortSince(now - 3 * 3_600_000, now)).toBe("3h");
    expect(shortSince(new Date(2026, 9, 25, 9, 0).getTime(), now)).toBe("4d");
  });

  it("says when a thread last ran", () => {
    const now = new Date(2026, 9, 29, 15, 0).getTime();
    expect(sinceLabel(now - 20_000, now)).toBe("just now");
    expect(sinceLabel(now - 12 * 60_000, now)).toBe("12m ago");
    expect(sinceLabel(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(sinceLabel(new Date(2026, 9, 28, 23, 0).getTime(), now)).toBe("yesterday");
    expect(sinceLabel(new Date(2026, 9, 25, 9, 0).getTime(), now)).toBe("4d ago");
  });

  it("sums the day in one line, and says nothing before the first turn", () => {
    expect(statsLine({ turns: 12, durationMs: 41 * 60_000, tokens: 228_400 })).toBe("Today · 12 turns · agents worked 41m · 228k tokens");
    expect(statsLine({ turns: 1, durationMs: 95 * 60_000, tokens: 1_500_000 })).toBe("Today · 1 turn · agents worked 1h 35m · 1.5M tokens");
    expect(statsLine({ turns: 0, durationMs: 0, tokens: 0 })).toBeNull();
  });
});

describe("chatTabMark", () => {
  const ready = (id: string) => ({ ...thread(id, "/w"), lastTurnEndedAt: 2, lastReadAt: 1 });
  it("is null when nothing needs you", () => {
    expect(chatTabMark([thread("a", "/w"), { ...thread("b", "/w"), status: "working" }])).toBeNull();
  });
  it("counts ready threads, leaving archived ones out", () => {
    expect(chatTabMark([ready("a"), ready("b"), { ...ready("c"), archived: true }])).toEqual({ kind: "ready", count: 2 });
  });
  it("lets a waiting thread win over ready ones", () => {
    expect(chatTabMark([ready("a"), { ...thread("b", "/w"), status: "waiting" }])).toEqual({ kind: "waiting", count: 1 });
  });

  describe("delegated chats", () => {
    const lead = { ...thread("lead", "/w/web"), lastTurnEndedAt: 5, lastReadAt: 5 };
    const kid = (id: string, parentId: string, at: number, extra: Partial<ChatThread> = {}): ChatThread => ({
      ...thread(id, "/w/web"),
      parentId,
      createdAt: at,
      ...extra,
    });

    it("hang under their lead, oldest first, and leave the sections", () => {
      const list = [kid("b", "lead", 2), kid("a", "lead", 1), kid("a1", "a", 3), lead];
      const children = railChildren(list);
      expect(railDescendants("lead", children).map((d) => [d.thread.id, d.depth])).toEqual([
        ["a", 1],
        ["a1", 2],
        ["b", 1],
      ]);
      expect(ids(railSections(list, null))).toEqual([["earlier", ["lead"]]]);
    });

    it("roll a child waiting on you up to the lead", () => {
      const list = [lead, kid("a", "lead", 1, { status: "waiting" }), kid("b", "lead", 2, { status: "working" })];
      expect(ids(railSections(list, null))).toEqual([["ready", ["lead"]]]);
      expect(railSections(list, null)[0].threads[0].state).toBe("waiting");
      expect(agentsLine(lead, railChildren(list))).toBe("2 agents · 1 waiting");
    });

    it("stand on their own when the lead is gone", () => {
      expect(ids(railSections([kid("a", "gone", 1)], null))).toEqual([["earlier", ["a"]]]);
      expect(agentsLine(lead, railChildren([lead]))).toBeNull();
    });
  });

  it("tidies a title for the rail: links dropped, first letter capitalised", () => {
    expect(displayTitle("analisis feedback dari mba Diva ini https://core.example/x/12")).toBe("Analisis feedback dari mba Diva ini");
    expect(displayTitle("cek https://a.dev/1 lalu https://b.dev/2 juga")).toBe("Cek lalu juga");
    expect(displayTitle("https://only.dev/link")).toBe("https://only.dev/link");
    expect(displayTitle("Already fine")).toBe("Already fine");
  });
});

describe("placeName (mockups/chat-remote-machine.html, decision 4)", () => {
  const machine = { host: "devbox-vps", user: null, port: null, workspaceId: "w1", paneId: null, cursor: null };
  it("names the machine after the folder, and says offline only when its host is down", () => {
    expect(placeName({ cwd: "/Users/me/app", machine: null })).toBe("app");
    expect(placeName({ cwd: "/srv/app", machine, link: "reconnecting" })).toBe("app · devbox-vps");
    expect(placeName({ cwd: "/srv/app", machine, link: "down" })).toBe("app · devbox-vps · offline");
  });

  it("folds a verifier into its worker: a label on the worker, the row only while it works or is open", () => {
    const worker = { ...thread("w", "/w"), parentId: "lead" };
    const verifier = { ...thread("v", "/w"), parentId: "w", role: "verifier", lastTurnEndedAt: 5, lastReadAt: 9 };
    const legacy = { ...thread("old", "/w"), parentId: "w", title: "verify · Trim comments · r2" };
    expect(isVerifier(verifier)).toBe(true);
    expect(isVerifier(legacy)).toBe(true);
    expect(isVerifier(worker)).toBe(false);
    expect(visibleChildren([verifier, legacy], null)).toEqual([]);
    expect(visibleChildren([verifier], "v")).toEqual([verifier]);
    expect(visibleChildren([{ ...verifier, status: "waiting" }], null)).toHaveLength(1);
    const children = railChildren([{ ...thread("lead", "/w") }, worker, verifier]);
    expect(agentsLine(thread("lead", "/w"), children)).toBe("1 agent · done");
  });

  it("says how a worker's verify goes", () => {
    const at = (status: "verifying" | "passed" | "unverified" | "blocked" | "interrupted", round = 1) => ({ verify: { status, round, rounds: 2 } });
    expect(verifyLabel({ verify: null })).toBeNull();
    expect(verifyLabel(at("verifying", 0))).toBe("verify queued");
    expect(verifyLabel(at("verifying"))).toBe("verifying 1/2");
    expect(verifyLabel(at("passed"))).toBe("verified ✓");
    expect(verifyLabel(at("unverified", 2))).toBe("unverified 2/2");
    expect(verifyLabel(at("blocked"))).toBe("blocked");
    expect(verifyLabel(at("interrupted"))).toBeNull();
  });
});
