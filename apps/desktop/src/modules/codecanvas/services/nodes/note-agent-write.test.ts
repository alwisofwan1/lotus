import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { nextNoteContent, planAgentNoteWrite, type AgentNoteWrite } from "./note-agent-write";

const note = (id: string, content: string, editedAt?: number): Node =>
  ({ id, type: "note", position: { x: 0, y: 0 }, data: { content, editedAt } }) as Node;
const agent: Node = { id: "ivo", type: "agent", position: { x: 1000, y: 40 }, data: {} } as Node;

const write = (patch: Partial<AgentNoteWrite>): AgentNoteWrite => ({
  projectId: "cp_1", mode: "append", noteId: "n1", markdown: "## Pantun\n\nbaris", nextContent: "", author: "Ivo", ...patch,
});

describe("planAgentNoteWrite", () => {
  const notTyping = () => false;

  it("appends to the editor's own, fresher content — not the store's", () => {
    const plan = planAgentNoteWrite(write({}), { nodes: [note("n1", "# TODO\n\ntyped a second ago", 5)], isUserTyping: notTyping });
    expect(plan).toEqual({ ok: true, kind: "update", noteId: "n1", content: "# TODO\n\ntyped a second ago\n\n## Pantun\n\nbaris" });
  });

  it("never writes over the user while they are typing in that note", () => {
    const plan = planAgentNoteWrite(write({}), { nodes: [note("n1", "x")], isUserTyping: (id) => id === "n1" });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/the user is typing/);
  });

  it("refuses a stale write against the canvas's editedAt", () => {
    const plan = planAgentNoteWrite(write({ mode: "replace", expectedEditedAt: 4 }), { nodes: [note("n1", "x", 5)], isUserTyping: notTyping });
    expect(!plan.ok && plan.error).toMatch(/^conflict/);
  });

  it("creates beside the calling agent, wired to it", () => {
    const plan = planAgentNoteWrite(write({ mode: "create", noteId: "note-new", markdown: "# New", callerNodeId: "ivo" }), { nodes: [agent], isUserTyping: notTyping });
    expect(plan).toEqual({ ok: true, kind: "create", noteId: "note-new", content: "# New", at: { x: 1000 - 440 - 80, y: 40 }, wireTo: "ivo" });
  });

  it("reports a note that left the canvas", () => {
    expect(planAgentNoteWrite(write({ noteId: "gone" }), { nodes: [], isUserTyping: notTyping }).ok).toBe(false);
  });
});

describe("nextNoteContent", () => {
  it("matches the Rust rule", () => {
    expect(nextNoteContent("append", "# TODO\n\nline\n\n", "## Pantun\n\na")).toBe("# TODO\n\nline\n\n## Pantun\n\na");
    expect(nextNoteContent("append", "", "\n\nfirst")).toBe("first");
    expect(nextNoteContent("replace", "old", "new")).toBe("new");
  });
});
