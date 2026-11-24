import { describe, it, expect } from "vitest";
import {
  centeredSpawnPosition,
  centerSpawnBurstOffset,
  canvasNodeSpawnSize,
  AGENT_NODE_SIZE,
} from "../canvas-spawn-position";
import { CANVAS_CREATE_NODE_KINDS } from "../commands/canvas-command";
import { DEFAULT_TERMINAL_SIZE, DEFAULT_NOTE_SIZE, DEFAULT_MUSIC_SIZE } from "../canvas-node-placement";

describe("centeredSpawnPosition", () => {
  const flow = { screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: x + 1000, y: y + 2000 }) };

  it("centres a node of the given size on the requested screen point", () => {
    const pos = centeredSpawnPosition(flow, AGENT_NODE_SIZE, { x: 0, y: 0 });
    expect(pos).toEqual({ x: 1000 - AGENT_NODE_SIZE.w / 2, y: 2000 - AGENT_NODE_SIZE.h / 2 });
  });

  it("returns undefined without a flow instance (caller falls back to a cascade)", () => {
    expect(centeredSpawnPosition(null, AGENT_NODE_SIZE, { x: 0, y: 0 })).toBeUndefined();
  });
});

describe("canvasNodeSpawnSize", () => {
  it("gives every create-node kind a concrete size so centering is exact, never a guess", () => {
    for (const kind of CANVAS_CREATE_NODE_KINDS) {
      const size = canvasNodeSpawnSize(kind);
      expect(size.w, `${kind} width`).toBeGreaterThan(0);
      expect(size.h, `${kind} height`).toBeGreaterThan(0);
    }
  });

  it("matches each node type's real default footprint", () => {
    expect(canvasNodeSpawnSize("terminal")).toEqual(DEFAULT_TERMINAL_SIZE);
    expect(canvasNodeSpawnSize("note")).toEqual(DEFAULT_NOTE_SIZE);
    expect(canvasNodeSpawnSize("music")).toEqual(DEFAULT_MUSIC_SIZE);
  });
});

describe("centerSpawnBurstOffset", () => {
  it("puts the first node of a burst exactly on the centre", () => {
    expect(centerSpawnBurstOffset(AGENT_NODE_SIZE, 0)).toEqual({ x: 0, y: 0 });
  });

  it("fans later nodes of the same burst out by their own footprint, so a batch never stacks", () => {
    const second = centerSpawnBurstOffset(AGENT_NODE_SIZE, 1);
    expect(Math.abs(second.x)).toBeGreaterThanOrEqual(AGENT_NODE_SIZE.w);
    const third = centerSpawnBurstOffset(AGENT_NODE_SIZE, 2);
    expect(third).not.toEqual(second);
  });

  it("scales the fan-out to the node size — a small note spreads less than a wide terminal", () => {
    const note = centerSpawnBurstOffset(DEFAULT_NOTE_SIZE, 1);
    const terminal = centerSpawnBurstOffset(DEFAULT_TERMINAL_SIZE, 1);
    expect(Math.abs(note.x)).toBeLessThan(Math.abs(terminal.x));
  });

  it("clamps past the last slot instead of running off into empty space", () => {
    const far = centerSpawnBurstOffset(AGENT_NODE_SIZE, 999);
    const last = centerSpawnBurstOffset(AGENT_NODE_SIZE, 8);
    expect(far).toEqual(last);
  });
});
