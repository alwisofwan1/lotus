import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { toCanvasSnapshot } from "../canvas-serialize";
import { decodeCanvasSnapshot } from "../canvas-snapshot-codec";
import { recordToNode } from "../canvas-node-factory";
import type { CanvasHostCellNodeRecord, CanvasNodeRecord, CanvasTerminalNodeRecord } from "../../types/canvas";

/**
 * Save the board, read it back, and hydrate it — the three hops an adopted cell has to survive.
 *
 * Testing them together rather than one at a time is deliberate: the bug this file was written
 * for was a field written by adoption and dropped by all three (`canvas-serialize`,
 * `canvas-snapshot-codec`, `recordToNode`). Any one of them alone would have hidden it.
 */
function roundTrip(nodes: Node[]) {
  const snapshot = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: [], noteContent: new Map() });
  const decoded = decodeCanvasSnapshot(JSON.parse(JSON.stringify(snapshot)));
  const records: CanvasNodeRecord[] = decoded.ok ? decoded.snapshot.nodes : [];
  return {
    records,
    repairs: decoded.repairs,
    nodes: records.map((record) => recordToNode(record, "/app", "proj-1")),
  };
}

describe("an adopted cell across a reload", () => {
  /**
   * **A real bug, found while writing ticket 12 and not part of it.** Ticket 11 shipped adoption
   * for `tui` cells, and `adoptedPaneId` — the whole difference between that node and an ordinary
   * terminal — never left memory. After a reload the node came back with the same label and the
   * same cwd, attached to nothing, opening a fresh shell on that machine beside the cell it was
   * supposed to be a window onto. Nothing on screen said so.
   */
  it("brings a terminal's pane id back, so it still attaches instead of opening a shell", () => {
    const adopted: Node = {
      id: "t1", type: "terminal", position: { x: 0, y: 0 }, width: 760, height: 520,
      data: { cwd: "/srv/api", terminalNumber: 1, label: "Rowan", adoptedPaneId: "p-42" },
    };

    const { records, nodes } = roundTrip([adopted]);
    expect((records[0] as CanvasTerminalNodeRecord).adoptedPaneId).toBe("p-42");
    expect(nodes[0].data.adoptedPaneId).toBe("p-42");
  });

  /** An ordinary terminal must not gain the field, or every node would look adopted. */
  it("leaves an ordinary terminal without one", () => {
    const plain: Node = {
      id: "t2", type: "terminal", position: { x: 0, y: 0 }, width: 760, height: 520,
      data: { cwd: "/app", terminalNumber: 1 },
    };
    const { records, nodes } = roundTrip([plain]);
    expect((records[0] as CanvasTerminalNodeRecord).adoptedPaneId).toBeUndefined();
    expect(nodes[0].data.adoptedPaneId).toBeUndefined();
  });

  /**
   * The Chat node has the same exposure and one more reason to care: it has no local process at
   * all, so the pane id is the entire handle on what it shows. A board reopened without it would
   * draw a titled box that can never ask the host anything.
   */
  it("brings a host cell node back whole", () => {
    const chat: Node = {
      id: "h1", type: "host-cell", position: { x: 40, y: 60 }, width: 480, height: 560,
      data: { adoptedPaneId: "ss-2ff4c016", cwd: "/home/alwi/workspace", label: "Claude Code", provider: "claude" },
    };

    const { records, nodes } = roundTrip([chat]);
    expect(records[0]).toMatchObject({
      type: "host-cell",
      id: "h1",
      adoptedPaneId: "ss-2ff4c016",
      cwd: "/home/alwi/workspace",
      label: "Claude Code",
      provider: "claude",
    });
    expect(nodes[0].type).toBe("host-cell");
    expect(nodes[0].data.adoptedPaneId).toBe("ss-2ff4c016");
    expect(nodes[0].position).toEqual({ x: 40, y: 60 });
  });

  /**
   * A host cell record with no pane id cannot ask anything and cannot be repaired into one, so
   * it is dropped and the repair says why. Drawing it would be an inert box the operator has to
   * work out is broken.
   */
  it("drops a host cell record that lost its pane id, and says so", () => {
    const decoded = decodeCanvasSnapshot({
      schemaVersion: 1, id: "default", rootDir: "/app", edges: [],
      nodes: [{ type: "host-cell", id: "h2", position: { x: 0, y: 0 }, label: "orphan" }],
    });
    expect(decoded.ok && decoded.snapshot.nodes).toEqual([]);
    expect(decoded.repairs.map((r) => r.reason).join(" ")).toContain("pane id");
  });

  /** The record shape the rest of the canvas compiles against, kept honest by one use of it. */
  it("hydrates a host cell record the codec produced", () => {
    const record: CanvasHostCellNodeRecord = {
      type: "host-cell", id: "h3", position: { x: 0, y: 0 }, size: { w: 480, h: 560 },
      adoptedPaneId: "ss-1", cwd: "/srv", label: "Kestrel", provider: "codex",
    };
    const node = recordToNode(record, "/app", null);
    expect(node.data.label).toBe("Kestrel");
    expect(node.data.provider).toBe("codex");
  });
});
