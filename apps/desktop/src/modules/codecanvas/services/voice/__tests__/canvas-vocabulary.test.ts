import { describe, expect, it } from "vitest";
import { buildCanvasVocabulary, canvasVoiceNodeNames } from "../canvas-vocabulary";
import type { AgentStatusSnapshot } from "../../agent-status-registry";

const agent = (name: string): AgentStatusSnapshot => ({ id: name, name, status: "idle", sessionId: null });

describe("buildCanvasVocabulary", () => {
  it("combines live agent names + node names, agents first", () => {
    const vocab = buildCanvasVocabulary({ roster: [agent("Ren"), agent("Sora")], nodeNames: ["Browser 1", "Spec"] });
    expect(vocab).toEqual(["Ren", "Sora", "Browser 1", "Spec"]);
  });

  it("dedupes across roster + nodes and trims, dropping blanks", () => {
    const vocab = buildCanvasVocabulary({ roster: [agent("Rin")], nodeNames: ["  Rin  ", "", "   ", "Notes"] });
    expect(vocab).toEqual(["Rin", "Notes"]);
  });

  it("is empty for an empty canvas", () => {
    expect(buildCanvasVocabulary({ roster: [], nodeNames: [] })).toEqual([]);
  });

  it("includes a renamed terminal and its stable Terminal N voice alias", () => {
    expect(canvasVoiceNodeNames([
      { type: "terminal", data: { label: "API server", terminalNumber: 2 } },
      { type: "terminal", data: { terminalNumber: 3 } },
      { type: "agent", data: { name: "Ren" } },
    ])).toEqual(["API server", "Terminal 2", "Terminal 3", "Ren"]);
  });
});
