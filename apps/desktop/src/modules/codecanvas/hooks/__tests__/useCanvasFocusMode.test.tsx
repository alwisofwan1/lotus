import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { useCanvasFocusMode } from "../useCanvasFocusMode";
import type { ArrangeBox } from "../../services/canvas-arrange";

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x: 0, y: 0 },
  data: {},
  ...extra,
});

type LayoutBounds = { minX: number; minY: number; width: number; height: number };
const BOUNDS: LayoutBounds = { minX: 0, minY: 0, width: 1000, height: 700 };

function makeDeps(nodes: Node[]) {
  const snapshot = new Map<string, ArrangeBox>(
    nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y, width: 400, height: 300 }]),
  );
  return {
    flowInstance: null,
    nodes,
    applyFocusLayout: vi.fn(
      (_heroId: string, _fit: { width: number; height: number }): LayoutBounds | null => BOUNDS,
    ),
    captureLayoutSnapshot: vi.fn(() => new Map(snapshot)),
    restoreLayoutSnapshot: vi.fn(
      (_snapshot: Map<string, ArrangeBox>): LayoutBounds | null => BOUNDS,
    ),
    onLeaveFocus: vi.fn(),
    onHeroChange: vi.fn(),
  };
}

describe("useCanvasFocusMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enters focus: snapshots once, applies the hero layout", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    expect(result.current.focusedNodeId).toBe("a");
    expect(deps.captureLayoutSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.applyFocusLayout).toHaveBeenCalledWith("a", expect.objectContaining({ width: expect.any(Number) }));
  });

  it("re-entering the current hero exits and restores the snapshot", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    act(() => result.current.enterFocus("a"));
    expect(result.current.focusedNodeId).toBeNull();
    expect(deps.restoreLayoutSnapshot).toHaveBeenCalledTimes(1);
  });

  it("swapping heroes keeps the ORIGINAL snapshot for the eventual exit", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    act(() => result.current.enterFocus("b"));
    expect(result.current.focusedNodeId).toBe("b");
    expect(deps.captureLayoutSnapshot).toHaveBeenCalledTimes(1); // NOT re-captured mid-focus
    act(() => result.current.exitFocus());
    expect(deps.restoreLayoutSnapshot).toHaveBeenCalledTimes(1);
  });

  it("exitFocus({restore:false}) leaves the board as-is (manual arrange takes over)", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    act(() => result.current.exitFocus({ restore: false }));
    expect(result.current.focusedNodeId).toBeNull();
    expect(deps.restoreLayoutSnapshot).not.toHaveBeenCalled();
  });

  it("does not enter the mode when the layout rejects the hero (shape/unknown)", () => {
    const deps = makeDeps([node("a")]);
    deps.applyFocusLayout.mockReturnValueOnce(null);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("ghost"));
    expect(result.current.focusedNodeId).toBeNull();
    // A later real entry snapshots fresh — the aborted attempt didn't leak one.
    act(() => result.current.enterFocus("a"));
    expect(deps.captureLayoutSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.focusedNodeId).toBe("a");
  });

  it("refreshFocus re-applies the hero layout while the hero is alive", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    act(() => result.current.refreshFocus());
    expect(deps.applyFocusLayout).toHaveBeenCalledTimes(2);
    expect(result.current.focusedNodeId).toBe("a");
  });

  it("still drops a dead hero from the snapshot it will eventually restore", () => {
    // This test used to assert that a closed hero EXITED focus. That is the behaviour the operator
    // asked to change: the fleet rail lists the hero with its own close button, so exiting meant
    // closing one agent dismantled the panel. Handover is covered below; what survives from the old
    // test is the invariant that still matters — a cell that no longer exists must not be restored.
    const deps = makeDeps([node("a"), node("b")]);
    const { result, rerender } = renderHook((props) => useCanvasFocusMode(props), { initialProps: deps });
    act(() => result.current.enterFocus("a"));

    rerender({ ...deps, nodes: [node("b")] });
    act(() => result.current.refreshFocus());
    act(() => result.current.exitFocus());

    expect(deps.restoreLayoutSnapshot).toHaveBeenCalledTimes(1);
    const restored = deps.restoreLayoutSnapshot.mock.calls[0][0];
    expect(restored.has("a")).toBe(false);
    expect(restored.has("b")).toBe(true);
  });

  it("Escape exits focus, but not while typing", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(result.current.focusedNodeId).toBe("a");
    input.remove();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.focusedNodeId).toBeNull();
  });
});

describe("onLeaveFocus — un-doing is not restoring", () => {
  // The bug this pins, seen live: arranging out of fleet mode left one visible node in a corner, a
  // fleet rail stranded at its old coordinates, and arrange tiling cells nobody could see.
  //
  // Cause: the fleet layout hides every non-hero cell, and the un-hide had been folded into the
  // restore wrapper. `handleArrange` exits with `restore: false` — deliberately, because the arrange
  // about to run owns the final positions — so the restore never ran and neither did the un-hide.
  // Two different concerns had been given one hook.

  it("runs on a restoring exit", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));

    act(() => result.current.exitFocus());

    expect(deps.onLeaveFocus).toHaveBeenCalledTimes(1);
    expect(deps.restoreLayoutSnapshot).toHaveBeenCalledTimes(1);
  });

  it("runs on an exit that deliberately skips the restore", () => {
    // The regression guard proper: this is the path `handleArrange` takes.
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));

    act(() => result.current.exitFocus({ restore: false }));

    expect(deps.onLeaveFocus).toHaveBeenCalledTimes(1);
    expect(deps.restoreLayoutSnapshot).not.toHaveBeenCalled();
  });

  it("does not run when there was no focus to leave", () => {
    const deps = makeDeps([node("a")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));

    act(() => result.current.exitFocus());

    expect(deps.onLeaveFocus).not.toHaveBeenCalled();
  });

  it("runs once per exit, not once per hero swap", () => {
    // Swapping heroes while focused is not leaving focus — the rail is still up and the cells it
    // stands for must stay hidden.
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));

    act(() => result.current.enterFocus("a"));
    act(() => result.current.enterFocus("b"));

    expect(deps.onLeaveFocus).not.toHaveBeenCalled();
  });
});

describe("promoteFocus — a list row is not a chrome gesture", () => {
  it("makes the clicked cell the hero", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));

    act(() => result.current.promoteFocus("b"));

    expect(result.current.focusedNodeId).toBe("b");
  });

  it("does nothing when that cell is already the hero", () => {
    // The reported bug: the rail's row was wired to `enterFocus`, which exits when re-invoked on the
    // current hero. Click one promoted, click two dropped focus — so a double-click on a row
    // dismissed the entire rail.
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));

    act(() => result.current.promoteFocus("a"));

    expect(result.current.focusedNodeId).toBe("a");
  });

  it("survives a double click, which is the whole point", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));

    act(() => result.current.promoteFocus("b"));
    act(() => result.current.promoteFocus("b"));

    expect(result.current.focusedNodeId).toBe("b");
  });

  it("enters focus from an unfocused board", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));

    act(() => result.current.promoteFocus("b"));

    expect(result.current.focusedNodeId).toBe("b");
  });
});

describe("a closed hero hands over instead of tearing the view down", () => {
  // The rail lists the hero with its own close button, so exiting focus here meant closing one agent
  // dismantled the panel the operator was working in.

  it("promotes the next cell when the hero disappears", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result, rerender } = renderHook((props: { nodes: Node[] }) =>
      useCanvasFocusMode({ ...deps, nodes: props.nodes }),
    { initialProps: { nodes: deps.nodes } });
    act(() => result.current.enterFocus("a"));

    rerender({ nodes: [node("b")] });
    act(() => result.current.refreshFocus());

    expect(result.current.focusedNodeId).toBe("b");
  });

  it("exits only when nothing is left to focus", () => {
    const deps = makeDeps([node("a")]);
    const { result, rerender } = renderHook((props: { nodes: Node[] }) =>
      useCanvasFocusMode({ ...deps, nodes: props.nodes }),
    { initialProps: { nodes: deps.nodes } });
    act(() => result.current.enterFocus("a"));

    rerender({ nodes: [] });
    act(() => result.current.refreshFocus());

    expect(result.current.focusedNodeId).toBeNull();
  });

  it("does not hand over a shape — it is not a cell", () => {
    const deps = makeDeps([node("a"), node("s1", { type: "shape" })]);
    const { result, rerender } = renderHook((props: { nodes: Node[] }) =>
      useCanvasFocusMode({ ...deps, nodes: props.nodes }),
    { initialProps: { nodes: deps.nodes } });
    act(() => result.current.enterFocus("a"));

    rerender({ nodes: [node("s1", { type: "shape" })] });
    act(() => result.current.refreshFocus());

    expect(result.current.focusedNodeId).toBeNull();
  });
});

describe("onHeroChange — the hero is the selection", () => {
  // The bug the operator saw as "no border, and I cannot type anywhere". `selectedNodeIdRef` is read
  // straight off `node.selected`, so with nothing selected there is no selection border AND every
  // gesture keyed to the selection is dead: Enter to dive in, close-node, toggle-focus, spatial nav.
  // The board felt stuck rather than merely unfocused.
  //
  // It was never explicit before because focus was only ever entered by double-clicking a node's
  // chrome, and ReactFlow selects a node on click — the selection arrived for free. Promoting from
  // the fleet rail bypassed that entirely.

  it("fires on entry", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));

    act(() => result.current.enterFocus("a"));

    expect(deps.onHeroChange).toHaveBeenCalledWith("a");
  });

  it("fires on a promote from the rail", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    vi.mocked(deps.onHeroChange).mockClear();

    act(() => result.current.promoteFocus("b"));

    expect(deps.onHeroChange).toHaveBeenCalledWith("b");
  });

  it("re-asserts on a re-tile, so a create or close cannot leave it on the wrong cell", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    vi.mocked(deps.onHeroChange).mockClear();

    act(() => result.current.refreshFocus());

    expect(deps.onHeroChange).toHaveBeenCalledWith("a");
  });

  it("names the new hero when a closed one hands over", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result, rerender } = renderHook((props: { nodes: Node[] }) =>
      useCanvasFocusMode({ ...deps, nodes: props.nodes }),
    { initialProps: { nodes: deps.nodes } });
    act(() => result.current.enterFocus("a"));
    vi.mocked(deps.onHeroChange).mockClear();

    rerender({ nodes: [node("b")] });
    act(() => result.current.refreshFocus());

    expect(deps.onHeroChange).toHaveBeenCalledWith("b");
  });

  it("does not fire when the layout was refused", () => {
    // A shape cannot be a hero, so nothing moved and nothing should be selected as one.
    const deps = makeDeps([node("a")]);
    deps.applyFocusLayout.mockReturnValueOnce(null);
    const { result } = renderHook(() => useCanvasFocusMode(deps));

    act(() => result.current.enterFocus("a"));

    expect(deps.onHeroChange).not.toHaveBeenCalled();
  });
});


describe("useCanvasFocusMode.settleFocus (project switch)", () => {
  it("exposes the active canonical snapshot for persistence without leaving Fleet", () => {
    const deps = makeDeps([node("a"), node("b", { position: { x: 500, y: 40 } })]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("b"));

    const focus = result.current as typeof result.current & {
      inspectFocus(): { heroId: string; snapshot: Map<string, ArrangeBox> } | null;
    };
    const session = focus.inspectFocus();

    expect(session?.heroId).toBe("b");
    expect(session?.snapshot.get("b")).toEqual({ x: 500, y: 40, width: 400, height: 300 });
    expect(result.current.focusedNodeId).toBe("b");
    expect(deps.onLeaveFocus).not.toHaveBeenCalled();
  });

  it("returns the hero identity with the canonical pre-focus layout", () => {
    const deps = makeDeps([node("a"), node("b", { position: { x: 500, y: 40 } })]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    act(() => result.current.promoteFocus("b"));

    let out: unknown;
    act(() => { out = result.current.settleFocus(); });

    expect(out).toMatchObject({ heroId: "b" });
    expect((out as { snapshot: Map<string, ArrangeBox> }).snapshot.get("b"))
      .toEqual({ x: 500, y: 40, width: 400, height: 300 });
  });

  it("returns null and touches nothing when not focused", () => {
    const deps = makeDeps([node("a"), node("b")]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    let out: unknown = "unset";
    act(() => { out = result.current.settleFocus(); });
    expect(out).toBeNull();
    expect(deps.onLeaveFocus).not.toHaveBeenCalled();
  });

  it("captures a node created during Fleet before it can become the hero", () => {
    const initial = [node("a"), node("b")];
    const deps = makeDeps(initial);
    const { result, rerender } = renderHook(
      ({ nodes }) => useCanvasFocusMode({
        ...deps,
        nodes,
        captureLayoutSnapshot: () => new Map(nodes.map((item) => [
          item.id,
          { x: item.position.x, y: item.position.y, width: 400, height: 300 },
        ])),
      }),
      { initialProps: { nodes: initial } },
    );
    act(() => result.current.enterFocus("a"));

    const created = node("c", { position: { x: 900, y: 80 } });
    rerender({ nodes: [...initial, created] });
    act(() => result.current.promoteFocus("c"));
    const session: { current: { heroId: string; snapshot: Map<string, ArrangeBox> } | null } = { current: null };
    act(() => { session.current = result.current.settleFocus(); });

    expect(session.current?.snapshot.get("c")).toEqual({ x: 900, y: 80, width: 400, height: 300 });
  });

  it("hands back the pre-focus snapshot, clears the mode, and does NOT animate a restore", () => {
    const deps = makeDeps([node("a"), node("b", { position: { x: 500, y: 40 } })]);
    const { result } = renderHook(() => useCanvasFocusMode(deps));
    act(() => result.current.enterFocus("a"));
    act(() => result.current.enterFocus("b")); // hero swap keeps the ORIGINAL snapshot
    const session: { current: { heroId: string; snapshot: Map<string, ArrangeBox> } | null } = { current: null };
    act(() => { session.current = result.current.settleFocus(); });
    expect(session.current?.snapshot.get("b")).toEqual({ x: 500, y: 40, width: 400, height: 300 });
    expect(result.current.focusedNodeId).toBeNull();
    expect(deps.onLeaveFocus).toHaveBeenCalledTimes(1);
    expect(deps.restoreLayoutSnapshot).not.toHaveBeenCalled();
    // The mode is really gone: a later exit has nothing to restore.
    act(() => result.current.exitFocus());
    expect(deps.restoreLayoutSnapshot).not.toHaveBeenCalled();
  });
});
