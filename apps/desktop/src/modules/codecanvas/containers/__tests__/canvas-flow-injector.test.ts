import { describe, expect, it, vi } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { createCanvasFlowInjector } from "../canvas-flow-config";

/**
 * Why this exists: node-drag smoothness.
 *
 * ReactFlow fires `onNodesChange` on every pointermove of a drag, so CanvasPage re-renders at
 * pointer rate. `injectCanvasNodeCallbacks` was called inline in the JSX and rebuilt EVERY node's
 * `data` object on every one of those renders. Each node component is `memo()`d on `data`, so a
 * fresh object per frame defeated all of it: dragging one Note re-rendered every Terminal and
 * every live Agent on the board, xterm hosts and all. That is the "patah-patah" (choppy) drag.
 *
 * `applyNodeChanges` keeps the object identity of nodes it did not touch (see applyChanges in
 * @xyflow/react — "no need to copy it"), so the fix is to preserve that same identity through the
 * injection layer: rebuild a node's injected form only when its VALUE actually changed. Then a
 * drag re-renders exactly one node.
 *
 * The tests below are about identity, not shape — shape is covered by canvas-flow-config.test.ts.
 */

const callbacks = {
  dispatchNodeCommand: vi.fn(),
  isSkillApplied: () => false,
  listAppliedSkills: () => [] as string[],
  hasBrowserNode: () => false,
};

function node(id: string, type: string, extra: Partial<Node> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {}, ...extra } as Node;
}

describe("createCanvasFlowInjector — node identity across renders", () => {
  it("returns the SAME injected object for a node whose source object did not change", () => {
    const inject = createCanvasFlowInjector();
    const nodes = [node("t1", "terminal"), node("a1", "agent")];

    const first = inject.nodes(nodes, [], callbacks);
    const second = inject.nodes(nodes, [], callbacks);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    // The `data` identity is the one memo() actually compares.
    expect(second[0].data).toBe(first[0].data);
    expect(second[1].data).toBe(first[1].data);
  });

  it("rebuilds ONLY the dragged node when a drag moves one of many", () => {
    const inject = createCanvasFlowInjector();
    const dragged = node("n1", "note");
    const untouched = [node("t1", "terminal"), node("a1", "agent"), node("k1", "task")];

    const first = inject.nodes([dragged, ...untouched], [], callbacks);
    // What applyNodeChanges does: a new object for the node that changed, same refs for the rest.
    const moved = { ...dragged, position: { x: 40, y: 12 }, dragging: true };
    const second = inject.nodes([moved, ...untouched], [], callbacks);

    expect(second[0]).not.toBe(first[0]);
    expect(second[0].position).toEqual({ x: 40, y: 12 });
    expect(second.slice(1)).toEqual(first.slice(1));
    for (let i = 1; i < second.length; i += 1) expect(second[i]).toBe(first[i]);
  });

  it("still rebuilds a node when only its injected (not its source) value changed", () => {
    const inject = createCanvasFlowInjector();
    const nodes = [node("t1", "terminal")];

    const first = inject.nodes(nodes, [], callbacks);
    // A Skills node is wired to the terminal — hasSkillsNode flips, though the node object did not.
    const withSkills = [...nodes, node("sk1", "skills")];
    const edges: Edge[] = [{ id: "e1", source: "t1", target: "sk1" }];
    const second = inject.nodes(withSkills, edges, callbacks);

    expect(second[0]).not.toBe(first[0]);
    expect(second[0].data.hasSkillsNode).toBe(true);
  });

  it("rebuilds when a freshly built array is dedup-equal but the callback identity changed", () => {
    const inject = createCanvasFlowInjector();
    const nodes = [node("a1", "agent", { data: { appliedSkills: ["ship"] } })];

    const first = inject.nodes(nodes, [], callbacks);
    // appliedSkills is rebuilt through a Set on every pass, so a naive `===` on the array would
    // report a change every frame. Value-equal arrays must NOT break reuse…
    expect(inject.nodes(nodes, [], callbacks)[0]).toBe(first[0]);
    // …but a genuinely different list must.
    const changed = inject.nodes(nodes, [], { ...callbacks, listAppliedSkills: () => ["review"] });
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0].data.appliedSkills).toEqual(["ship", "review"]);
  });

  it("drops cache entries for removed nodes instead of leaking them for the session", () => {
    const inject = createCanvasFlowInjector();
    const keep = node("t1", "terminal");
    const doomed = node("t2", "terminal");

    inject.nodes([keep, doomed], [], callbacks);
    const afterClose = inject.nodes([keep], [], callbacks);
    expect(afterClose).toHaveLength(1);

    // A new node reusing a closed node's id must not inherit the dead entry.
    const reborn = node("t2", "terminal", { position: { x: 900, y: 900 } });
    const reopened = inject.nodes([keep, reborn], [], callbacks);
    expect(reopened[1].position).toEqual({ x: 900, y: 900 });
  });
});

describe("createCanvasFlowInjector — edge identity across renders", () => {
  const edgeCallbacks = { onDelete: vi.fn(), onLabelChange: vi.fn() };

  it("keeps injected edge identity when the edge did not change", () => {
    const inject = createCanvasFlowInjector();
    const edges: Edge[] = [{ id: "e1", source: "a", target: "b" }];

    const first = inject.edges(edges, edgeCallbacks);
    const second = inject.edges(edges, edgeCallbacks);

    expect(second[0]).toBe(first[0]);
    expect(second[0].data).toBe(first[0].data);
  });

  it("rebuilds an edge whose label changed", () => {
    const inject = createCanvasFlowInjector();
    const first = inject.edges([{ id: "e1", source: "a", target: "b" }], edgeCallbacks);
    const second = inject.edges([{ id: "e1", source: "a", target: "b", label: "calls" }], edgeCallbacks);

    expect(second[0]).not.toBe(first[0]);
    expect(second[0].label).toBe("calls");
  });
});

describe("createCanvasFlowInjector — open Run Node (#74)", () => {
  it("makes an open Run Node's card box inert, and leaves a closed one alone", () => {
    const inject = createCanvasFlowInjector();
    const [open, closed] = inject.nodes([
      node("r1", "run", { selected: true, data: { open: true } }),
      node("r2", "run", { data: {} }),
    ], [], callbacks);
    expect(open).toMatchObject({ selected: false, selectable: false, draggable: false, className: "run-node--open" });
    expect(closed).not.toHaveProperty("className");
    expect(closed).not.toHaveProperty("selectable");
  });
});
