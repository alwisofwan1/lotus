import { describe, expect, it } from "vitest";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import type { PaneActivity } from "@/modules/workspace-shell/types";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import {
  livePaneCount,
  paneKindForCell,
  railPaneForCell,
  toRailWorkspaces,
} from "@/modules/workspace-shell/services/cell-mapping";

const terminal: GridCell = {
  id: "t1",
  cwd: "/Users/alwi/workspace/Lotus/apps/desktop",
  type: "terminal",
  runtimeSessionId: "r1",
  runtimeStatus: "live",
  agentCommand: "claude",
};

describe("paneKindForCell", () => {
  it("translates CodeSpace's words into the shell's", () => {
    expect(paneKindForCell({ ...terminal, type: "workbench" } as GridCell)).toBe("editor");
    /* A stored Bridge cell has no kind of its own any more — it is dropped when the snapshot is
       restored, and anything that still reaches here is read as the terminal it will behave as. */
    expect(paneKindForCell({ ...terminal, type: "orchestrator" } as unknown as GridCell)).toBe("terminal");
    expect(paneKindForCell({ id: "c", cwd: "/x", type: "chat", sessionId: "s1" })).toBe("thread");
    expect(paneKindForCell(terminal)).toBe("terminal");
  });

  it("falls back to terminal for a type this build has never heard of", () => {
    expect(paneKindForCell({ ...terminal, type: "simulator" } as unknown as GridCell)).toBe("terminal");
  });
});

describe("railPaneForCell", () => {
  it("names a terminal by its agent name, then its folder — never the whole path", () => {
    expect(railPaneForCell({ ...terminal, agentName: "Nara" } as GridCell)).toMatchObject({
      title: "Nara",
      meta: "desktop · claude",
    });
    expect(railPaneForCell(terminal).title).toBe("desktop");
  });

  it("names a new-chat pane by its thread's title, or New chat before the first message (07d)", () => {
    const cell = { id: "c1", cwd: "/x/y", type: "chat" as const, sessionId: "" };
    expect(railPaneForCell({ ...cell, thread: { id: null } }).title).toBe("New chat");
    expect(railPaneForCell({ ...cell, thread: { id: "t1", title: "Fix the login test" } })).toMatchObject({
      kind: "thread",
      title: "Fix the login test",
    });
  });

  /**
   * The row no longer decides what a pane is DOING — `pane-activity` does, from live signals this
   * module cannot see. What it must still do is carry that answer through untouched, including
   * the stamp an age is measured from.
   */
  it("carries the activity it is handed, rather than deriving one", () => {
    const pane = railPaneForCell({ ...terminal } as GridCell, "needs-you", 1_700);
    expect(pane).toMatchObject({ activity: "needs-you", activitySince: 1_700 });
  });

  it("defaults to at-rest when nothing is known", () => {
    expect(railPaneForCell({ ...terminal } as GridCell).activity).toBe("idle");
  });

  /**
   * The handle has to survive the title generator.
   *
   * `agentName` is what you address a pane by in an `@mention` (ADR-0024), and it used to lose its
   * slot the moment a conversation title arrived — after which the pane no longer said its own
   * name anywhere. It now travels in its own field, so the header can wear both.
   */
  it("carries the agent's handle even after a generated title takes the title slot", () => {
    const named = {
      ...terminal,
      agentName: "Nara",
      title: "Check empty pages",
      titleStatus: "ready",
    } as GridCell;

    expect(railPaneForCell(named)).toMatchObject({
      title: "Check empty pages",
      persona: "Nara",
    });
  });

  it("gives a pane no handle when nothing has named it", () => {
    expect(railPaneForCell(terminal).persona).toBeUndefined();
  });

  it("carries which CLI is running, so the header can draw its mark", () => {
    expect(railPaneForCell(terminal).runner).toMatchObject({ provider: "claude", label: "Claude" });
    expect(railPaneForCell({ ...terminal, agentCommand: "" } as GridCell).runner).toBeUndefined();
  });
});

describe("livePaneCount", () => {
  it("counts running processes only — a browser pane is open, not alive", () => {
    const cells: GridCell[] = [
      terminal,
      { ...terminal, id: "t2", runtimeStatus: "idle" } as GridCell,
      { id: "b1", cwd: "/x", type: "browser", url: "", zoom: 1, loading: false },
    ];
    expect(livePaneCount(cells)).toBe(1);
  });
});

describe("toRailWorkspaces", () => {
  it("names a workspace by its label, falling back to its folder", () => {
    const workspaces = [
      { id: "w1", label: "  ", color: "#fff", cwd: "/Users/alwi/pocket", rows: 1, cols: 1, cells: [terminal] },
    ] as Workspace[];
    expect(toRailWorkspaces(workspaces)[0]).toMatchObject({ name: "pocket", liveCount: 1 });
  });
});

describe("toRailWorkspaces with Frames", () => {
  const cell = (id: string): GridCell => ({ ...terminal, id });
  const frame = (id: string, name: string, createdAt: number, paneIds: string[]) =>
    ({ id, name, color: "teal" as const, createdAt, paneIds, layout: null });
  const workspace = (paneLayout: Workspace["paneLayout"]) =>
    ({ id: "w1", label: "w", color: "", cwd: "/w", rows: 1, cols: 1, cells: ["a", "b", "c", "d"].map(cell), paneLayout }) as Workspace;

  it("lists Frame rows newest first, then the loose panes", () => {
    const [rail] = toRailWorkspaces([workspace({
      mode: "grid",
      framesMigrated: true,
      frames: [frame("old", "api", 1, ["a"]), frame("new", "docs", 2, ["b", "c"])],
    })]);

    expect(rail.frames).toMatchObject([
      { id: "new", name: "docs", color: "teal", initial: "D", paneCount: 2, paneIds: ["b", "c"] },
      { id: "old", name: "api", color: "teal", initial: "A", paneCount: 1, paneIds: ["a"] },
    ]);
    expect(rail.loosePanes?.map((pane) => pane.id)).toEqual(["d"]);
  });

  it("does not count a closed pane in its Frame", () => {
    const [rail] = toRailWorkspaces([workspace({ mode: "grid", framesMigrated: true, frames: [frame("f", "x", 1, ["a", "gone"])] })]);
    expect(rail.frames?.[0]).toMatchObject({ paneCount: 1, paneIds: ["a"] });
  });

  it("has no Frame rows before the workspace is migrated", () => {
    expect(toRailWorkspaces([workspace({ mode: "grid" })])[0].frames).toBeUndefined();
  });
  describe("a Frame row's rolled-up status", () => {
    const framed = (paneIds: string[]) => workspace({ mode: "grid", framesMigrated: true, frames: [frame("f", "x", 1, paneIds)] });
    const statusOf = (activities: Record<string, PaneActivity>, unread: string[] = []) =>
      toRailWorkspaces(
        [framed(["a", "b", "c", "d"])],
        new Map(Object.entries(activities).map(([id, activity]) => [id, { activity, since: 1 } as PaneActivityState])),
        new Set(unread),
      )[0].frames?.[0].status;

    it("takes the most urgent member: needs you > failed > working > new result > idle", () => {
      expect(statusOf({ a: "working", b: "failed", c: "needs-you" }, ["d"])).toBe("needs-you");
      expect(statusOf({ a: "working", b: "failed" }, ["d"])).toBe("failed");
      expect(statusOf({ a: "working" }, ["d"])).toBe("working");
      expect(statusOf({}, ["d"])).toBe("unread");
      expect(statusOf({})).toBe("idle");
    });
  });

  it("stacks at most three member marks and counts the rest as +N", () => {
    const cells = ["a", "b", "c", "d", "e", "f"].map(cell);
    const ws = { ...workspace({ mode: "grid", framesMigrated: true, frames: [frame("f", "x", 1, ["a", "b", "c", "d", "e", "f"])] }), cells } as Workspace;
    const [rail] = toRailWorkspaces([ws], new Map([["b", { activity: "working", since: 1 } as PaneActivityState]]));
    expect(rail.frames?.[0].marks.map((pane) => pane.id)).toEqual(["a", "b", "c"]);
    expect(rail.frames?.[0].marks[1].activity).toBe("working");
    expect(rail.frames?.[0].moreCount).toBe(3);
  });

  it("counts needs-you over every pane, framed or loose, for a collapsed folder", () => {
    const [rail] = toRailWorkspaces(
      [workspace({ mode: "grid", framesMigrated: true, frames: [frame("f", "x", 1, ["a", "b"])] })],
      new Map([["a", { activity: "needs-you" }], ["d", { activity: "needs-you" }]] as [string, PaneActivityState][]),
    );
    expect(rail.needsYouCount).toBe(2);
  });

  it("marks a loose pane's new result too", () => {
    const [rail] = toRailWorkspaces([workspace({ mode: "grid", framesMigrated: true, frames: [] })], new Map(), new Set(["d"]));
    expect(rail.loosePanes?.find((pane) => pane.id === "d")?.unread).toBe(true);
  });
});

describe("a rail row says something new on its second line", () => {
  /**
   * From the native window, 2026-09-20: a terminal in `interview-hss` listed as
   *
   *   interview-hss
   *   interview-hss
   *
   * The title falls back to the folder and the meta line led with the same folder, so the row
   * spent two lines saying one thing — and two terminals in that folder were indistinguishable.
   */
  it("does not repeat the folder under a title that is already the folder", () => {
    const cell: GridCell = {
      id: "t1",
      cwd: "/Users/alwi/workspace/interview-hss",
      type: "terminal",
      runtimeSessionId: "s1",
      runtimeStatus: "live",
    };

    const row = railPaneForCell(cell);

    expect(row.title).toBe("interview-hss");
    expect(row.meta).not.toContain("interview-hss");
  });

  it("uses the second line for what the terminal is running", () => {
    const cell: GridCell = {
      id: "t1",
      cwd: "/tmp/repo",
      type: "terminal",
      runtimeSessionId: "s1",
      runtimeStatus: "live",
      agentCommand: "claude",
    };

    expect(railPaneForCell(cell).meta).toBe("claude");
  });

  it("keeps the folder on the second line when the pane has a name of its own", () => {
    // Here the folder IS new information, because the title no longer carries it.
    const cell: GridCell = {
      id: "t1",
      cwd: "/tmp/repo",
      type: "terminal",
      runtimeSessionId: "s1",
      runtimeStatus: "live",
      agentName: "build",
    };

    const row = railPaneForCell(cell);
    expect(row.title).toBe("build");
    expect(row.meta).toBe("repo");
  });

  it("does not repeat the folder under a thread whose title already carries it", () => {
    const cell: GridCell = { id: "c1", cwd: "/tmp/repo", type: "chat", sessionId: "", thread: { id: "t1", title: "Haloooo · repo" } };

    expect(railPaneForCell(cell).meta).toBe("thread");
  });
});

describe("toRailWorkspaces tells identical rows apart", () => {
  it("numbers panes that would otherwise read the same", () => {
    // Two shells in one folder is the ordinary case, not an edge case.
    const workspace = {
      id: "w1",
      label: "Workspace 2",
      color: "",
      cwd: "/tmp/repo",
      rows: 1,
      cols: 2,
      cells: [
        { id: "t1", cwd: "/tmp/repo", type: "terminal", runtimeSessionId: "a", runtimeStatus: "live" },
        { id: "t2", cwd: "/tmp/repo", type: "terminal", runtimeSessionId: "b", runtimeStatus: "live" },
      ],
    } as never;

    const [rail] = toRailWorkspaces([workspace]);

    expect(rail.panes.map((pane) => pane.title)).toEqual(["repo", "repo 2"]);
  });

  it("leaves a row alone when nothing else shares its title", () => {
    const workspace = {
      id: "w1",
      label: "Workspace 2",
      color: "",
      cwd: "/tmp/repo",
      rows: 1,
      cols: 2,
      cells: [
        { id: "t1", cwd: "/tmp/repo", type: "terminal", runtimeSessionId: "a", runtimeStatus: "live" },
        { id: "t2", cwd: "/tmp/other", type: "terminal", runtimeSessionId: "b", runtimeStatus: "live" },
      ],
    } as never;

    const [rail] = toRailWorkspaces([workspace]);

    expect(rail.panes.map((pane) => pane.title)).toEqual(["repo", "other"]);
  });
});

describe("the count badge on a rail row", () => {
  /**
   * Ours only puts a number where one exists and is true; a terminal has nothing to count, and
   * putting a 0 or an invented figure there would be worse than empty space.
   */
  it("gives a terminal no badge at all", () => {
    const cell: GridCell = {
      id: "t1",
      cwd: "/tmp/repo",
      type: "terminal",
      runtimeSessionId: "s1",
      runtimeStatus: "live",
    };

    expect(railPaneForCell(cell).badge).toBeUndefined();
  });
});
