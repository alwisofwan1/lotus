import { describe, expect, it } from "vitest";
import { matchLocalIntent } from "../canvas-nl-fastpath";
import { resolveNlIntents, type CanvasNodeRef, type NlCommandContext, type NlResolution } from "../canvas-nl-command";
import { CANVAS_CREATE_NODE_KINDS } from "../commands/canvas-command";
import { resolveFrame, type FrameQuery } from "../canvas-frames";
import { runNlCommand } from "../canvas-nl-runner";

const FRAMES = ["Auth", "Bug triage", "Billing"];
const match = (t: string, frameNames: readonly string[] | undefined = FRAMES) =>
  matchLocalIntent(t, { nodeKinds: CANVAS_CREATE_NODE_KINDS, frameNames });

const refs: CanvasNodeRef[] = [
  { id: "t1", kind: "task", name: "T1" },
  { id: "t2", kind: "task", name: "T2", frameId: "f_auth" },
  { id: "rev", kind: "agent", name: "Reviewer" },
  { id: "f_auth", kind: "frame", name: "Auth" },
  { id: "f_bug", kind: "frame", name: "Bug triage" },
  { id: "f_bill", kind: "frame", name: "Billing" },
];
const ctx: NlCommandContext = { roster: [], nodeRefs: refs };
const run = (t: string): NlResolution[] | { error: string } => {
  const intents = match(t);
  if (!intents) throw new Error(`fast path missed: ${t}`);
  return resolveNlIntents(intents, ctx) as NlResolution[] | { error: string };
};
const cmdOf = (r: NlResolution[] | { error: string }) => {
  if (!Array.isArray(r)) throw new Error(r.error);
  const e = r[0].effect;
  if (e.kind !== "command") throw new Error("not a command");
  return e.command;
};

describe("frame fast path: parse", () => {
  it("create, Indonesian and English", () => {
    expect(match("buat frame Auth dari T1 dan reviewer")).toEqual([{ action: "create_frame", title: "Auth", members: ["T1", "reviewer"] }]);
    expect(match("make frame Auth from T1 and reviewer")).toEqual([{ action: "create_frame", title: "Auth", members: ["T1", "reviewer"] }]);
    expect(match("create a frame from T1, T2")).toEqual([{ action: "create_frame", members: ["T1", "T2"] }]);
  });
  it("move in", () => {
    expect(match("pindahkan T2 ke Bug triage")).toEqual([{ action: "move_to_frame", targets: ["T2"], frame: "Bug triage" }]);
    expect(match("move T2 to frame 2")).toEqual([{ action: "move_to_frame", targets: ["T2"], frameIndex: 2 }]);
    expect(match("move T1 and T2 to Auth")).toEqual([{ action: "move_to_frame", targets: ["T1", "T2"], frame: "Auth" }]);
  });
  it("move out", () => {
    expect(match("keluarkan T2 dari frame")).toEqual([{ action: "leave_frame", targets: ["T2"] }]);
    expect(match("take T2 out of frame Auth")).toEqual([{ action: "leave_frame", targets: ["T2"], frame: "Auth" }]);
  });
  it("go to", () => {
    expect(match("buka Auth")).toEqual([{ action: "go_to_frame", frame: "Auth" }]);
    expect(match("go to bug")).toEqual([{ action: "go_to_frame", frame: "bug" }]);
    expect(match("frame 2")).toEqual([{ action: "go_to_frame", frameIndex: 2 }]);
    expect(match("go to frame 3")).toEqual([{ action: "go_to_frame", frameIndex: 3 }]);
    expect(match("buka frame Billing")).toEqual([{ action: "go_to_frame", frame: "Billing" }]);
  });
  it("does not steal unrelated commands", () => {
    expect(match("buka browser")).toEqual([{ action: "open_browser" }]);
    expect(match("focus Skye")).toEqual([{ action: "focus", target: "Skye" }]);
    expect(match("move Skye to the left")).toBeNull();
    expect(match("pindah ke proyek Beta")).toEqual([{ action: "switch_project", target: "Beta" }]);
  });
});

const resolveFrameQuery = (query: FrameQuery, frames: readonly { id: string; name: string }[]) => resolveFrame(frames, query, "loose");

describe("frame name resolution (loose mode)", () => {
  const frames = refs.filter((r) => r.kind === "frame");
  it("exact, then case-insensitive, then prefix", () => {
    expect(resolveFrameQuery({ name: "Auth" }, frames)).toMatchObject({ ok: true, id: "f_auth" });
    expect(resolveFrameQuery({ name: "auth" }, frames)).toMatchObject({ ok: true, id: "f_auth" });
    expect(resolveFrameQuery({ name: "bug" }, frames)).toMatchObject({ ok: true, id: "f_bug" });
  });
  it("exact beats a prefix sibling", () => {
    const f = [{ id: "a", kind: "frame", name: "Auth" }, { id: "b", kind: "frame", name: "Auth v2" }];
    expect(resolveFrameQuery({ name: "Auth" }, f)).toMatchObject({ ok: true, id: "a" });
  });
  it("ambiguous prefix and unknown are errors", () => {
    const f = [{ id: "a", kind: "frame", name: "Auth web" }, { id: "b", kind: "frame", name: "Auth api" }];
    expect(resolveFrameQuery({ name: "auth" }, f)).toMatchObject({ ok: false });
    expect(resolveFrameQuery({ name: "zzz" }, frames)).toMatchObject({ ok: false });
  });
  it("by 1-based position", () => {
    expect(resolveFrameQuery({ index: 2 }, frames)).toMatchObject({ ok: true, id: "f_bug" });
    expect(resolveFrameQuery({ index: 9 }, frames)).toMatchObject({ ok: false });
  });
});

describe("frame intents: resolve", () => {
  it("create-frame resolves node names, never Frames", () => {
    expect(cmdOf(run("buat frame Auth dari T1 dan reviewer"))).toEqual({ kind: "create-frame", nodeIds: ["t1", "rev"], title: "Auth" });
  });
  it("an unknown node name changes nothing", () => {
    expect(run("make frame X from T1 and ghost")).toMatchObject({ error: expect.stringContaining("ghost") });
  });
  it("move in resolves a Frame by prefix", () => {
    expect(cmdOf(run("pindahkan T2 ke Bug triage"))).toEqual({ kind: "move-to-frame", nodeIds: ["t2"], frameId: "f_bug" });
    expect(cmdOf(run("move T1 to bug"))).toEqual({ kind: "move-to-frame", nodeIds: ["t1"], frameId: "f_bug" });
  });
  it("unknown Frame is a clear error", () => {
    expect(run("move T1 to frame Nope")).toMatchObject({ error: expect.stringContaining("Nope") });
  });
  it("move out sets frameId undefined", () => {
    expect(cmdOf(run("keluarkan T2 dari frame"))).toEqual({ kind: "move-to-frame", nodeIds: ["t2"], frameId: undefined });
  });
  it("move out of a named Frame the node is not in errors", () => {
    expect(run("take T1 out of frame Auth")).toMatchObject({ error: expect.stringContaining("T1") });
  });
  it("go to flies, by name and by number", () => {
    expect(cmdOf(run("buka Auth"))).toEqual({ kind: "fly-to-frame", frameId: "f_auth" });
    expect(cmdOf(run("frame 3"))).toEqual({ kind: "fly-to-frame", frameId: "f_bill" });
    expect(run("frame 7")).toMatchObject({ error: expect.any(String) });
  });
  it("is non-destructive", () => {
    const r = run("buka Auth") as NlResolution[];
    expect(r[0].destructive).toBe(false);
  });
});

describe("runNlCommand uses the local path for Frames (no model call)", () => {
  it("resolves without calling the planner, deriving Frame names from nodeRefs", async () => {
    const callModel = async () => {
      throw new Error("LLM must not be called");
    };
    const r = await runNlCommand("pindahkan T2 ke Bug triage", { callModel, roster: [], nodeRefs: refs, nodeKinds: CANVAS_CREATE_NODE_KINDS });
    expect(Array.isArray(r) && r[0].effect).toEqual({ kind: "command", command: { kind: "move-to-frame", nodeIds: ["t2"], frameId: "f_bug" } });
  });
});
