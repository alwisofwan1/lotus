import { describe, expect, it } from "vitest";
import { agentEditingFile, lineDiffCounts } from "../file-agent-link";
import type { AgentState } from "../../narration/agent-state-registry";

function state(paneId: string, filesTouched: string[], lastEventAt: number): AgentState {
  return { paneId, currentTool: null, lastTool: null, filesTouched, errorCount: 0, lastErrorAt: null, lastPrompt: null, turnActive: false, eventCount: 1, lastEventAt };
}

describe("lineDiffCounts", () => {
  it("counts added lines", () => {
    expect(lineDiffCounts("a\nb\n", "a\nx\ny\nb\n")).toEqual({ added: 2, removed: 0 });
  });
  it("counts a replaced line as one added and one removed", () => {
    expect(lineDiffCounts("a\nb\nc\n", "a\nB\nc\n")).toEqual({ added: 1, removed: 1 });
  });
  it("counts deleted lines", () => {
    expect(lineDiffCounts("a\nb\nc\nd\n", "a\nd\n")).toEqual({ added: 0, removed: 2 });
  });
  it("is zero when unchanged", () => {
    expect(lineDiffCounts("a\n", "a\n")).toEqual({ added: 0, removed: 0 });
  });
});

describe("agentEditingFile", () => {
  const live = [
    { id: "node-a", name: "Skye" },
    { id: "node-b", name: "Nova", hookPaneId: "pane-b" },
  ];
  it("names the live agent that touched the path most recently", () => {
    const states = [state("node-a", ["/r/a.ts"], 100), state("pane-b", ["/r/a.ts"], 200)];
    expect(agentEditingFile({ states, live, path: "/r/a.ts" })).toEqual({ nodeId: "node-b", name: "Nova" });
  });
  it("ignores agents no longer on the board", () => {
    const states = [state("gone", ["/r/a.ts"], 300), state("node-a", ["/r/a.ts"], 100)];
    expect(agentEditingFile({ states, live, path: "/r/a.ts" })).toEqual({ nodeId: "node-a", name: "Skye" });
  });
  it("is null when no live agent touched it", () => {
    expect(agentEditingFile({ states: [state("node-a", ["/r/b.ts"], 1)], live, path: "/r/a.ts" })).toBeNull();
  });
});
