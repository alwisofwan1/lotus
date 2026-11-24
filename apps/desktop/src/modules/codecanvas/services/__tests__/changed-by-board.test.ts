import { describe, expect, it } from "vitest";
import type { AgentState } from "../narration/agent-state-registry";
import { changedByBoard } from "../changed-by-board";

const state = (paneId: string, filesTouched: string[], lastEventAt: number): AgentState => ({
  paneId,
  currentTool: null,
  lastTool: null,
  filesTouched,
  errorCount: 0,
  lastErrorAt: null,
  lastPrompt: null,
  turnActive: false,
  eventCount: 1,
  lastEventAt,
});

const live = [
  { id: "node-1", name: "Skye", hookPaneId: "p1" },
  { id: "node-2", name: "Nova", hookPaneId: "p2" },
];
const base = { rootDir: "/repo", live, statusOf: () => "M" as const };

describe("changedByBoard", () => {
  it("lists each path once, newest first, with the agent that touched it last", () => {
    const rows = changedByBoard({
      ...base,
      states: [
        state("p1", ["/repo/a.ts", "/repo/b.ts"], 100),
        state("p2", ["/repo/b.ts", "/repo/c.ts"], 200),
      ],
    });
    expect(rows.map((r) => [r.path, r.agent])).toEqual([
      ["/repo/c.ts", "Nova"],
      ["/repo/b.ts", "Nova"],
      ["/repo/a.ts", "Skye"],
    ]);
  });

  it("within one agent the file touched last comes first", () => {
    const rows = changedByBoard({ ...base, states: [state("p1", ["/repo/a.ts", "/repo/b.ts"], 100)] });
    expect(rows.map((r) => r.path)).toEqual(["/repo/b.ts", "/repo/a.ts"]);
  });

  it("drops files outside the board's root, and gives the path relative to it", () => {
    const rows = changedByBoard({ ...base, states: [state("p1", ["/elsewhere/x.ts", "/repo/src/y.ts"], 1)] });
    expect(rows).toEqual([{ path: "/repo/src/y.ts", relativePath: "src/y.ts", agent: "Skye", agentNodeId: "node-1", status: "M" }]);
  });

  it("marks a file git calls new as A, others as M", () => {
    const rows = changedByBoard({
      ...base,
      statusOf: (path) => (path.endsWith("new.ts") ? "A" : "M"),
      states: [state("p1", ["/repo/new.ts", "/repo/old.ts"], 1)],
    });
    expect(rows.map((r) => [r.path, r.status])).toEqual([
      ["/repo/old.ts", "M"],
      ["/repo/new.ts", "A"],
    ]);
  });

  it("carries the agent's canvas node id so a row can open its file wired to that agent", () => {
    const rows = changedByBoard({ ...base, states: [state("p1", ["/repo/a.ts"], 100)] });
    expect(rows.map((r) => [r.path, r.agentNodeId])).toEqual([["/repo/a.ts", "node-1"]]);
  });

  it("skips agents with no node on this board: the registry is process-wide", () => {
    const rows = changedByBoard({
      ...base,
      states: [state("p1", ["/repo/a.ts"], 100), state("other-board", ["/repo/b.ts"], 500)],
    });
    expect(rows.map((r) => r.path)).toEqual(["/repo/a.ts"]);
  });
});
