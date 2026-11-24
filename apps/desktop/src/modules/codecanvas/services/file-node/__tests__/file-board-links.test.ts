import { describe, expect, it, vi } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { createFileBoardLinks } from "../file-board-links";

function setup(initial: { nodes?: Node[]; edges?: Edge[] } = {}) {
  const nodes: Node[] = initial.nodes ?? [{ id: "term-1", type: "terminal", position: { x: 0, y: 0 }, data: {} }];
  const edges: Edge[] = initial.edges ?? [];
  const calls: string[] = [];
  const addFileNode = vi.fn((path: string) => {
    const existing = nodes.find((n) => n.type === "file" && n.data.path === path);
    if (existing) return existing.id;
    nodes.push({ id: `file-${nodes.length}`, type: "file", position: { x: 0, y: 0 }, data: { path } });
    return nodes[nodes.length - 1].id;
  });
  const links = createFileBoardLinks({
    addFileNode,
    nodes: () => nodes,
    edges: () => edges,
    appendEdges: (added) => edges.push(...added),
    closeDock: () => calls.push("close-dock"),
    reveal: (id, also) => calls.push(`reveal:${id}:${(also ?? []).join(",")}`),
  });
  return { links, nodes, edges, calls, addFileNode };
}

describe("showOnBoard", () => {
  it("creates the File Node when the board has none, closes the Dock, then reveals it", () => {
    const { links, nodes, calls } = setup();
    links.showOnBoard("/repo/a.ts");
    expect(nodes.filter((n) => n.type === "file")).toHaveLength(1);
    expect(calls).toEqual(["close-dock", `reveal:${nodes[1].id}:`]);
  });

  it("reveals the node that is already there instead of adding another", () => {
    const { links, nodes, calls } = setup({ nodes: [{ id: "file-9", type: "file", position: { x: 0, y: 0 }, data: { path: "/repo/a.ts" } }] });
    links.showOnBoard("/repo/a.ts");
    expect(nodes).toHaveLength(1);
    expect(calls).toEqual(["close-dock", "reveal:file-9:"]);
  });
});

describe("openFromAgent", () => {
  it("creates the File Node wired to the agent's terminal with a context wire", () => {
    const { links, edges, nodes } = setup();
    links.openFromAgent("/repo/a.ts", "term-1");
    const file = nodes.find((n) => n.type === "file")!;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: file.id, target: "term-1", data: { wireKind: "context" } });
  });

  it("reuses an existing File Node and does not wire the same pair twice", () => {
    const { links, edges, nodes, addFileNode } = setup();
    links.openFromAgent("/repo/a.ts", "term-1");
    links.openFromAgent("/repo/a.ts", "term-1");
    expect(nodes.filter((n) => n.type === "file")).toHaveLength(1);
    expect(addFileNode).toHaveBeenCalledTimes(2);
    expect(edges).toHaveLength(1);
  });

  it("wires an already-placed File Node that had no wire yet", () => {
    const { links, edges } = setup({
      nodes: [
        { id: "term-1", type: "terminal", position: { x: 0, y: 0 }, data: {} },
        { id: "file-9", type: "file", position: { x: 0, y: 0 }, data: { path: "/repo/a.ts" } },
      ],
    });
    links.openFromAgent("/repo/a.ts", "term-1");
    expect(edges.map((e) => [e.source, e.target])).toEqual([["file-9", "term-1"]]);
  });

  it("closes the Dock and reveals the file together with its agent", () => {
    const { links, calls, nodes } = setup();
    links.openFromAgent("/repo/a.ts", "term-1");
    expect(calls).toEqual(["close-dock", `reveal:${nodes[1].id}:term-1`]);
  });
});
