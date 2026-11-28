import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  buildFrameSwitcher,
  appendEmptyFrameAt,
  frameBounds,
  frameChipTooltip,
  frameSwitcherSlotCount,
  worstFrameStatus,
} from "./canvas-frame-switcher";

const frame = (id: string, title: string, extra: Partial<Node> = {}): Node => ({
  id, type: "frame", position: { x: 0, y: 0 }, data: { title }, width: 100, height: 50, ...extra,
});
const member = (id: string, frameId?: string, type = "agent"): Node => ({
  id, type, position: { x: 0, y: 0 }, data: frameId ? { frameId } : {},
});
const snap = (id: string, status: string) => ({ id, status }) as never;

describe("worstFrameStatus", () => {
  it("ranks needs-you > error > running > connecting > completed > idle", () => {
    expect(worstFrameStatus(["idle", "running", "needs-you", "error"])).toBe("needs-you");
    expect(worstFrameStatus(["idle", "running", "error"])).toBe("error");
    expect(worstFrameStatus(["idle", "connecting", "running"])).toBe("running");
    expect(worstFrameStatus(["completed", "idle"])).toBe("completed");
    expect(worstFrameStatus([])).toBe("idle");
  });
});

describe("buildFrameSwitcher", () => {
  it("makes one chip per Frame in array order, labelled 1, 2", () => {
    const nodes = [frame("f1", "Bug triage"), member("a"), frame("f2", "Docs")];
    const { chips, overflow } = buildFrameSwitcher(nodes, []);
    expect(chips.map((c) => [c.frameId, c.label, c.index])).toEqual([["f1", "1", 1], ["f2", "2", 2]]);
    expect(overflow).toEqual([]);
  });

  it("aggregates member agent status and flags needsYou", () => {
    const nodes = [frame("f1", "A"), member("a1", "f1"), member("a2", "f1"), member("loose")];
    const { chips } = buildFrameSwitcher(nodes, [snap("a1", "running"), snap("a2", "needs-you"), snap("loose", "error")]);
    expect(chips[0].status).toBe("needs-you");
    expect(chips[0].tone).toBe("blocked");
    expect(chips[0].needsYou).toBe(true);
  });

  it("shows chips 1-4 and folds Frames past 4 (older canvases) into +N with their real numbers", () => {
    const nodes = Array.from({ length: 7 }, (_, i) => frame(`f${i + 1}`, `F${i + 1}`));
    const { chips, overflow } = buildFrameSwitcher(nodes, []);
    expect(chips).toHaveLength(4);
    expect(overflow.map((c) => c.label)).toEqual(["5", "6", "7"]);
  });
});

describe("frameChipTooltip", () => {
  it("says needs you in words, with the hotkey", () => {
    const nodes = [frame("f1", "Bug triage"), member("a", "f1")];
    const [chip] = buildFrameSwitcher(nodes, [snap("a", "needs-you")]).chips;
    expect(frameChipTooltip(chip, "MacIntel")).toBe("Bug triage · needs you · ⌥1");
  });
  it("names the hotkey as Windows writes it off macOS", () => {
    const nodes = [frame("f1", "Bug triage"), member("a", "f1")];
    const [chip] = buildFrameSwitcher(nodes, [snap("a", "needs-you")]).chips;
    expect(frameChipTooltip(chip, "Win32")).toBe("Bug triage · needs you · Alt+1");
  });
  it("omits the hotkey for overflow chips", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => frame(`f${i + 1}`, `F${i + 1}`));
    const [chip] = buildFrameSwitcher(nodes, []).overflow;
    expect(frameChipTooltip(chip)).toBe("F5 · idle");
  });
});

describe("frameSwitcherSlotCount", () => {
  it("counts chips, the +N chip and the + button while there is room", () => {
    expect(frameSwitcherSlotCount(0, 0)).toBe(1);
    expect(frameSwitcherSlotCount(2, 0)).toBe(3);
    expect(frameSwitcherSlotCount(4, 0)).toBe(4);
    expect(frameSwitcherSlotCount(4, 2)).toBe(5);
  });
});

describe("frameBounds", () => {
  it("returns the node box", () => {
    expect(frameBounds(frame("f", "x", { position: { x: 10, y: 20 } }))).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
});

describe("appendEmptyFrameAt limit and placement", () => {
  it("adds nothing at the Frame limit", () => {
    const nodes = Array.from({ length: 4 }, (_, i) => frame(`f${i}`, `Frame ${i + 1}`, { position: { x: i * 1000, y: 0 } }));
    expect(appendEmptyFrameAt(nodes, "new", { x: 0, y: 0 })).toHaveLength(4);
  });
  it("lands in free space, not on top of a Frame under the centre", () => {
    const nodes = [frame("f1", "Frame 1", { position: { x: 0, y: 0 }, width: 640, height: 420 })];
    const created = appendEmptyFrameAt(nodes, "new", { x: 320, y: 210 })[1];
    const overlaps = created.position.x < 640 && created.position.x + (created.width ?? 0) > 0 && created.position.y < 420 && created.position.y + (created.height ?? 0) > 0;
    expect(overlaps).toBe(false);
  });
});

describe("appendEmptyFrameAt", () => {
  it("appends a default-size Frame centred on the point, titled after the highest Frame N", () => {
    const nodes = [frame("f1", "Frame 3")];
    const next = appendEmptyFrameAt(nodes, "new", { x: 1000, y: 500 });
    expect(next).toHaveLength(2);
    const created = next[1];
    expect(created.id).toBe("new");
    expect(created.type).toBe("frame");
    expect((created.data as { title: string }).title).toBe("Frame 4");
    expect(created.position.x + (created.width ?? 0) / 2).toBe(1000);
    expect(created.position.y + (created.height ?? 0) / 2).toBe(500);
  });
});
