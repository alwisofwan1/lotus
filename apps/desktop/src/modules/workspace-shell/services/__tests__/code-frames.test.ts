import { describe, expect, it } from "vitest";
import {
  createTerminalV2LayoutFromPaneIds,
  getTerminalV2LayoutPaneIds,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import type { CodeFrame } from "@/modules/codespace/components/types";
import { balancedPaneLayout } from "@/modules/workspace-shell/services/pane-arrangement";
import { addPaneToFrame, anchorFramesAt, assignNewPanes, createFrame, deleteFrame, migrateFrames, placeNewPanes, reconcileFrames, recolorFrame, renameFrame, restoreFrame, takePaneOut } from "@/modules/workspace-shell/services/code-frames";

const frame = (id: string, paneIds: string[], over: Partial<CodeFrame> = {}): CodeFrame => ({
  id,
  name: id,
  color: "violet",
  createdAt: 1,
  paneIds,
  layout: createTerminalV2LayoutFromPaneIds(paneIds, paneIds[0] ?? null),
  ...over,
});
const ids = (f: CodeFrame) => getTerminalV2LayoutPaneIds(f.layout?.root ?? null);

describe("migrateFrames", () => {
  const legacy = { name: "api", color: "teal" as const, now: 42, newId: () => "f1" };

  it("puts every pane of a 2+ pane workspace in one Frame named after it, in the same layout", () => {
    const tree = createTerminalV2LayoutFromPaneIds(["a", "b", "c"], "b");
    const next = migrateFrames({ mode: "grid", terminalV2Layout: tree }, ["a", "b", "c"], legacy);

    expect(next.framesMigrated).toBe(true);
    expect(next.frames).toEqual([
      { id: "f1", name: "api", color: "teal", createdAt: 42, paneIds: ["a", "b", "c"], layout: tree },
    ]);
  });

  it("leaves a single pane loose", () => {
    const next = migrateFrames({ mode: "grid" }, ["a"], legacy);
    expect(next.frames).toEqual([]);
    expect(next.framesMigrated).toBe(true);
  });

  it("runs once: a second run, or a run after the Frame was deleted, changes nothing", () => {
    const once = migrateFrames({ mode: "grid" }, ["a", "b"], legacy);
    expect(migrateFrames(once, ["a", "b"], legacy)).toBe(once);

    const deleted = { ...once, frames: [] };
    expect(migrateFrames(deleted, ["a", "b"], legacy)).toBe(deleted);
  });
});

describe("reconcileFrames", () => {
  it("drops a closed pane from its Frame and from that Frame's layout, keeping the rest", () => {
    const [next] = reconcileFrames([frame("f", ["a", "b", "c"])], ["a", "c", "x"]);
    expect(next.paneIds).toEqual(["a", "c"]);
    expect(ids(next)).toEqual(["a", "c"]);
  });

  it("keeps a Frame whose last pane closed, empty", () => {
    expect(reconcileFrames([frame("f", ["a"])], [])).toEqual([{ ...frame("f", ["a"]), paneIds: [], layout: null }]);
  });

  it("lets a pane belong to one Frame only: the first one keeps it", () => {
    const next = reconcileFrames([frame("f", ["a", "b"]), frame("g", ["b", "c"])], ["a", "b", "c"]);
    expect(next.map((f) => f.paneIds)).toEqual([["a", "b"], ["c"]]);
  });

  it("returns the same array when nothing changed, so a write can be skipped", () => {
    const frames = [frame("f", ["a", "b"])];
    expect(reconcileFrames(frames, ["a", "b"])).toBe(frames);
  });
});

describe("createFrame", () => {
  it("adds an empty Frame with the next palette colour, newest by createdAt", () => {
    const next = createFrame([frame("f", ["a"], { color: "violet" })], { name: "New Frame", now: 9, newId: () => "g" });
    expect(next.at(-1)).toEqual({ id: "g", name: "New Frame", color: "teal", createdAt: 9, paneIds: [], layout: null });
  });

  it("wraps the palette after six", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => frame(id, []));
    expect(createFrame(six, { name: "x", now: 1, newId: () => "g" }).at(-1)?.color).toBe("violet");
  });
});

describe("renameFrame", () => {
  it("takes the trimmed name", () => {
    expect(renameFrame([frame("f", [])], "f", "  Docs ")[0].name).toBe("Docs");
  });

  it("ignores an empty or unchanged name, returning the same array", () => {
    const frames = [frame("f", [])];
    expect(renameFrame(frames, "f", "   ")).toBe(frames);
    expect(renameFrame(frames, "f", "f")).toBe(frames);
  });
});

describe("recolorFrame", () => {
  it("changes only that Frame's colour", () => {
    const next = recolorFrame([frame("f", []), frame("g", [])], "g", "rose");
    expect(next.map((f) => f.color)).toEqual(["violet", "rose"]);
  });

  it("returns the same array for the colour it already has", () => {
    const frames = [frame("f", [])];
    expect(recolorFrame(frames, "f", "violet")).toBe(frames);
  });
});

describe("deleteFrame and restoreFrame", () => {
  it("removes the Frame only: its panes stay, now in no Frame (loose)", () => {
    const { frames, deleted } = deleteFrame([frame("f", ["a", "b"]), frame("g", ["c"])], "f");
    expect(frames.map((f) => f.id)).toEqual(["g"]);
    expect(deleted).toMatchObject({ index: 0, frame: { id: "f", paneIds: ["a", "b"] } });
  });

  it("puts the Frame back where it was, with its members and layout", () => {
    const f = frame("f", ["a", "b"]);
    const { frames, deleted } = deleteFrame([frame("e", []), f, frame("g", ["c"])], "f");
    const back = restoreFrame(frames, deleted!);
    expect(back.map((x) => x.id)).toEqual(["e", "f", "g"]);
    expect(back[1]).toBe(f);
  });

  it("takes back a member that joined another Frame after the delete", () => {
    const { frames, deleted } = deleteFrame([frame("f", ["a", "b"]), frame("g", ["c"])], "f");
    const moved = addPaneToFrame(frames, "g", "a", "vertical");
    const back = restoreFrame(moved, deleted!);
    expect(back.map((x) => x.paneIds)).toEqual([["a", "b"], ["c"]]);
    expect(ids(back[1])).toEqual(["c"]);
  });

  it("does nothing for a Frame that is not there", () => {
    const frames = [frame("f", [])];
    expect(deleteFrame(frames, "gone")).toEqual({ frames, deleted: null });
  });
});

describe("placeNewPanes", () => {
  const down = () => "vertical" as const;
  const init = { now: 9, newId: () => "split" };

  it("joins the Frame on screen", () => {
    const [next] = placeNewPanes([frame("f", ["a"])], new Set(["a"]), ["a", "b"], { frameId: "f" }, down, init);
    expect(next.paneIds).toEqual(["a", "b"]);
  });

  it("puts a pane opened beside a loose pane into a new unnamed split with it", () => {
    const next = placeNewPanes([], new Set(["a"]), ["a", "b"], { paneId: "a" }, down, init);
    expect(next).toEqual([expect.objectContaining({ id: "split", name: "", createdAt: 9, paneIds: ["a", "b"] })]);
    expect(ids(next[0])).toEqual(["a", "b"]);
  });

  it("splits beside the pane you were on, not the Frame's last active one (⌘D then ⌘⇧D)", () => {
    // ⌘D left the new pane "b" as the Frame's active pane; focus moved back to "a".
    const stale = [frame("f", ["a", "b"], { layout: { ...createTerminalV2LayoutFromPaneIds(["a", "b"], "a"), activePaneId: "b" } })];
    const [next] = placeNewPanes(anchorFramesAt(stale, "a"), new Set(["a", "b"]), ["a", "b", "c"], { frameId: "f" }, down, init);
    expect(ids(next)).toEqual(["a", "c", "b"]);
    expect(anchorFramesAt(stale, null)).toBe(stale);
    expect(anchorFramesAt(stale, "b")).toBe(stale);
  });

  it("stays loose with nothing on screen, a Frame that is gone, or no new pane", () => {
    const frames = [frame("f", ["a"])];
    expect(placeNewPanes(frames, new Set(["a"]), ["a", "b"], null, down, init)).toBe(frames);
    expect(placeNewPanes(frames, new Set(["a"]), ["a", "b"], { frameId: "gone" }, down, init)).toBe(frames);
    expect(placeNewPanes([], new Set(["a"]), ["a"], { paneId: "a" }, down, init)).toEqual([]);
  });

  describe("a pane an agent spawned (#319)", () => {
    const by = (map: Record<string, string>) => (paneId: string) => map[paneId];

    it("joins its spawner's Frame, even when another Frame is on screen", () => {
      const frames = [frame("mine", ["agent"]), frame("shown", ["x"])];
      const next = placeNewPanes(frames, new Set(["agent", "x"]), ["agent", "x", "b"], { frameId: "shown" }, down, init, by({ b: "agent" }));
      expect(next.map((f) => f.paneIds)).toEqual([["agent", "b"], ["x"]]);
    });

    it("joins the Frame on screen when its spawner is in none", () => {
      const next = placeNewPanes([frame("shown", ["x"])], new Set(["agent", "x"]), ["agent", "x", "b"], { frameId: "shown" }, down, init, by({ b: "agent" }));
      expect(next[0].paneIds).toEqual(["x", "b"]);
    });

    it("stays loose when its spawner is in no Frame and none is on screen", () => {
      const frames = [frame("other", ["x"])];
      expect(placeNewPanes(frames, new Set(["agent", "x"]), ["agent", "x", "b"], null, down, init, by({ b: "agent" }))).toBe(frames);
    });

    it("does not make a split with a loose pane on screen once it has its spawner's Frame", () => {
      const next = placeNewPanes([frame("mine", ["agent"])], new Set(["agent", "c"]), ["agent", "c", "b"], { paneId: "c" }, down, init, by({ b: "agent" }));
      expect(next.map((f) => f.paneIds)).toEqual([["agent", "b"]]);
    });
  });
});

describe("splits (unnamed Frames)", () => {
  it("dissolve once one pane is left; a named Frame stays", () => {
    const split = frame("s", ["a", "b"], { name: "" });
    expect(reconcileFrames([split, frame("f", ["c", "d"])], ["a", "c"]).map((f) => f.id)).toEqual(["f"]);
  });

  it("take a pane out: it leaves its Frame, and a split left with one pane dissolves", () => {
    const frames = [frame("s", ["a", "b"], { name: "" }), frame("f", ["c", "d"])];
    expect(takePaneOut(frames, "a").map((f) => f.id)).toEqual(["f"]);
    expect(takePaneOut(frames, "c")[1].paneIds).toEqual(["d"]);
  });

  it("become a named Frame when given a name", () => {
    expect(renameFrame([frame("s", ["a", "b"], { name: "" })], "s", "Fix bug")[0].name).toBe("Fix bug");
  });
});

describe("assignNewPanes", () => {
  const down = () => "vertical" as const;

  it("puts each pane not seen before into the target Frame", () => {
    const next = assignNewPanes([frame("f", ["a"])], new Set(["a"]), ["a", "b", "c"], "f", down);
    expect(next[0].paneIds).toEqual(["a", "b", "c"]);
  });

  it("lays a squad (several new panes at once) out as one balanced block beside the active pane", () => {
    const [next] = assignNewPanes([frame("f", ["a", "b"])], new Set(["a", "b"]), ["a", "b", "x", "y", "z"], "f", down);
    expect(next.paneIds).toEqual(["a", "b", "x", "y", "z"]);
    expect(ids(next)).toEqual(["a", "x", "y", "z", "b"]);
    // The block replaces the active pane's spot as one split: [a | block], not a chain of halvings.
    const root = next.layout?.root;
    const graft = root?.kind === "split" ? root.children[0] : null;
    expect(graft).toMatchObject({ kind: "split", direction: "vertical", sizes: [50, 50] });
    const block = graft?.kind === "split" ? graft.children[1] : null;
    expect(block).toEqual(balancedPaneLayout(["x", "y", "z"], "x").root);
    expect(next.layout?.activePaneId).toBe("x");
  });

  it("gives an empty Frame the squad's own balanced layout", () => {
    const [next] = assignNewPanes([frame("f", [])], new Set(), ["x", "y", "z", "w"], "f", down);
    expect(next.layout).toEqual(balancedPaneLayout(["x", "y", "z", "w"], "x"));
  });

  it("leaves known panes and panes already in a Frame where they are", () => {
    const frames = [frame("f", ["a"]), frame("g", ["b"])];
    expect(assignNewPanes(frames, new Set(["a", "x"]), ["a", "b", "x"], "f", down)).toBe(frames);
  });
});

describe("addPaneToFrame", () => {
  it("splits the Frame's active pane, so the new pane is beside where you were", () => {
    const [next] = addPaneToFrame([frame("f", ["a", "b"])], "f", "c", "vertical");
    expect(next.paneIds).toEqual(["a", "b", "c"]);
    expect(ids(next)).toEqual(["a", "c", "b"]);
    expect(next.layout?.activePaneId).toBe("c");
  });

  it("gives an empty Frame its first pane", () => {
    const [next] = addPaneToFrame([frame("f", [])], "f", "a", "horizontal");
    expect(next.paneIds).toEqual(["a"]);
    expect(ids(next)).toEqual(["a"]);
  });

  it("takes the pane out of any other Frame first, so it is in one only", () => {
    const next = addPaneToFrame([frame("f", ["a"]), frame("g", ["b"])], "g", "a", "horizontal");
    expect(next.map((f) => f.paneIds)).toEqual([[], ["b", "a"]]);
  });
});
