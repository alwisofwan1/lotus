import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { NOTE_AGENT_GAP, noteAgentSpawnPosition, noteAgentWire } from "./note-agent-link";

describe("note → agent link", () => {
  it("places the agent to the right of the note, top-aligned", () => {
    const note = { id: "n1", type: "note", position: { x: 100, y: 40 }, width: 440, height: 520, data: {} } as Node;
    expect(noteAgentSpawnPosition(note)).toEqual({ x: 100 + 440 + NOTE_AGENT_GAP, y: 40 });
  });

  it("wires note → agent as a context wire, like a hand-drawn one", () => {
    const edge = noteAgentWire("n1", "a1");
    expect(edge).toMatchObject({ source: "n1", target: "a1", data: { wireKind: "context" } });
  });
});
