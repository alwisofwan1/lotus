import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { decideMutationTidy, isFrameFocused, planFrameRetile, type FrameFocusRecord } from "../canvas-frame-retile";

const frame = (id: string): Node => ({ id, type: "frame", position: { x: 0, y: 0 }, width: 800, height: 600, data: { title: id } });
const win = (id: string, frameId?: string): Node => ({ id, type: "terminal", position: { x: 0, y: 0 }, width: 300, height: 200, data: frameId ? { frameId } : {} });

const vp = { x: -100, y: -50, zoom: 0.8 };
const focus = (over: Partial<FrameFocusRecord> = {}): FrameFocusRecord => ({ frameId: "a", viewport: vp, settledAt: 1000, ...over });

describe("isFrameFocused (decision 39: 'focused' = the camera is still where focusing the Frame put it)", () => {
  it("is true while the viewport sits on the focus target", () => {
    expect(isFrameFocused(focus(), vp)).toBe(true);
  });
  it("tolerates sub-threshold drift (inertia, sub-pixel rounding)", () => {
    expect(isFrameFocused(focus(), { x: vp.x + 20, y: vp.y - 20, zoom: vp.zoom * 1.02 })).toBe(true);
  });
  it("is false once the user panned away", () => {
    expect(isFrameFocused(focus(), { ...vp, x: vp.x + 400 })).toBe(false);
  });
  it("is false once the user zoomed (Overview zooms far out)", () => {
    expect(isFrameFocused(focus(), { ...vp, zoom: 0.3 })).toBe(false);
  });
  it("is false with no focus record, or one whose camera target is not known yet", () => {
    expect(isFrameFocused(null, vp)).toBe(false);
    expect(isFrameFocused(focus({ viewport: null }), vp)).toBe(false);
  });
});

describe("planFrameRetile", () => {
  const nodes = [frame("a"), frame("b"), win("m1", "a"), win("m2", "b")];
  const base = { nodes, viewport: vp, nodeFocused: false, now: 5000 };

  it("focused Frame: refill the screen and keep the camera on it", () => {
    expect(planFrameRetile({ ...base, frameId: "a", focus: focus() })).toEqual({ mode: "focused", frameId: "a" });
  });
  it("a Frame the camera is not on re-tiles inside its box, camera untouched", () => {
    expect(planFrameRetile({ ...base, frameId: "b", focus: focus() })).toEqual({ mode: "in-box", frameId: "b" });
    expect(planFrameRetile({ ...base, frameId: "a", focus: null })).toEqual({ mode: "in-box", frameId: "a" });
  });
  it("the user panned away from the focused Frame: in-box, camera stays", () => {
    expect(planFrameRetile({ ...base, frameId: "a", focus: focus(), viewport: { ...vp, x: 900 } })).toEqual({ mode: "in-box", frameId: "a" });
  });
  it("Overview open (zoomed far out): in-box, never yanks the camera in", () => {
    expect(planFrameRetile({ ...base, frameId: "a", focus: focus(), viewport: { x: 0, y: 0, zoom: 0.15 } })).toEqual({ mode: "in-box", frameId: "a" });
  });
  it("waits while the focus glide is still running, then runs", () => {
    expect(planFrameRetile({ ...base, now: 700, frameId: "a", focus: focus({ settledAt: 1000 }) })).toEqual({ mode: "wait", ms: 300 });
  });
  it("a focus whose glide never reported settled (camera target unknown) is not treated as focused", () => {
    expect(planFrameRetile({ ...base, frameId: "a", focus: focus({ viewport: null, settledAt: Infinity }) })).toEqual({ mode: "in-box", frameId: "a" });
  });
  it("node-focus mode keeps its own behaviour: skip", () => {
    expect(planFrameRetile({ ...base, frameId: "a", focus: focus(), nodeFocused: true })).toEqual({ mode: "skip" });
  });
  it("a Frame that no longer exists: skip", () => {
    expect(planFrameRetile({ ...base, frameId: "gone", focus: focus() })).toEqual({ mode: "skip" });
  });
  it("a Frame with no window members (closed the last one): skip — empty Frame stays, camera stays", () => {
    expect(planFrameRetile({ ...base, nodes: [frame("a")], frameId: "a", focus: focus() })).toEqual({ mode: "skip" });
  });
});

describe("decideMutationTidy (what the debounced create/close tidy may do)", () => {
  const flags = { tidyMode: "open-close" as const };
  it("node-focus mode refreshes the focus layout, as before", () => {
    expect(decideMutationTidy({ kind: "close", isNote: false, flags, nodeFocused: true, nodes: [frame("a")] })).toBe("refresh-focus");
  });
  it("REGRESSION: closing a member while a Frame exists never runs the whole-canvas arrange", () => {
    expect(decideMutationTidy({ kind: "close", isNote: false, flags, nodeFocused: false, nodes: [frame("a"), win("m", "a")] })).toBe("none");
  });
  it("opening a node while a Frame exists never runs the whole-canvas arrange either", () => {
    expect(decideMutationTidy({ kind: "open", isNote: false, flags, nodeFocused: false, nodes: [frame("a"), win("m", "a")] })).toBe("none");
  });
  it("with no Frame, the existing settings still gate the whole-canvas arrange", () => {
    expect(decideMutationTidy({ kind: "open", isNote: false, flags, nodeFocused: false, nodes: [win("m")] })).toBe("arrange-all");
    expect(decideMutationTidy({ kind: "open", isNote: false, flags: { tidyMode: "off" as const }, nodeFocused: false, nodes: [win("m")] })).toBe("none");
  });
});

describe("planFrameRetile with the auto-tidy setting (opening a node arranges again)", () => {
  const nodes = [frame("a"), frame("b"), win("m1", "a"), win("m2", "b")];
  const on = { tidyMode: "open-close" as const };
  const off = { tidyMode: "off" as const };
  const base = { nodes, viewport: vp, nodeFocused: false, now: 5000, focus: null, activeFrameId: "a" };

  it("REGRESSION: a node opened with tidy-on-open fills the screen with its Frame and moves the camera there, even with nothing focused", () => {
    expect(planFrameRetile({ ...base, frameId: "a", intent: { kind: "open", isNote: false }, flags: on })).toEqual({ mode: "focused", frameId: "a" });
  });
  it("a node opened into another Frame (an agent's) re-tiles there and leaves the user's camera alone", () => {
    expect(planFrameRetile({ ...base, frameId: "b", intent: { kind: "open", isNote: false }, flags: on })).toEqual({ mode: "in-box", frameId: "b" });
  });
  it("closing a member of the active Frame with tidy-on-close refills the screen with that Frame only", () => {
    expect(planFrameRetile({ ...base, frameId: "a", intent: { kind: "close", isNote: false }, flags: on })).toEqual({ mode: "focused", frameId: "a" });
  });
  it("closing a member of a Frame that is not active re-tiles in its box, the camera stays", () => {
    expect(planFrameRetile({ ...base, frameId: "b", intent: { kind: "close", isNote: false }, flags: on })).toEqual({ mode: "in-box", frameId: "b" });
  });
  it("with the tidy settings off, decision 39 applies unchanged", () => {
    expect(planFrameRetile({ ...base, frameId: "a", intent: { kind: "open", isNote: false }, flags: off })).toEqual({ mode: "in-box", frameId: "a" });
    expect(planFrameRetile({ ...base, frameId: "a", intent: { kind: "close", isNote: false }, flags: off })).toEqual({ mode: "in-box", frameId: "a" });
  });
  it("a note follows its own auto-arrange-notes switch", () => {
    expect(planFrameRetile({ ...base, frameId: "a", intent: { kind: "open", isNote: true }, flags: { tidyMode: "notes" as const } })).toEqual({ mode: "focused", frameId: "a" });
  });
  it("Frame Overview open: the tidy never flies the camera in", () => {
    expect(planFrameRetile({ ...base, frameId: "a", intent: { kind: "open", isNote: false }, flags: on, overviewOpen: true })).toEqual({ mode: "in-box", frameId: "a" });
  });
  it("node-focus mode, a running glide and an emptied Frame still win over the tidy", () => {
    const intent = { kind: "open" as const, isNote: false };
    expect(planFrameRetile({ ...base, frameId: "a", intent, flags: on, nodeFocused: true })).toEqual({ mode: "skip" });
    expect(planFrameRetile({ ...base, frameId: "a", intent, flags: on, now: 700, focus: focus({ settledAt: 1000 }) })).toEqual({ mode: "wait", ms: 300 });
    expect(planFrameRetile({ ...base, nodes: [frame("a")], frameId: "a", intent: { kind: "close", isNote: false }, flags: on })).toEqual({ mode: "skip" });
  });
});
