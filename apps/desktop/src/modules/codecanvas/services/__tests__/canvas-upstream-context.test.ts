import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { resolveUpstreamContext } from "../canvas-upstream-context";
import { canvasHandoffStore } from "../canvas-handoff-store";

function flow(nodes: Node[], edges: Edge[]) {
  return {
    getEdges: () => edges,
    getNode: (id: string) => nodes.find((node) => node.id === id),
  };
}

describe("resolveUpstreamContext", () => {
  it("preserves Rich Markdown Note content and exposes embedded Note Asset refs", () => {
    const markdown = "# Spec\n\n- [ ] Review\n\n![diagram](lotus-note-asset://asset_1)";
    const sources = resolveUpstreamContext(
      flow(
        [
          { id: "note-1", type: "note", position: { x: 0, y: 0 }, data: { content: markdown } },
          { id: "agent-1", type: "agent", position: { x: 0, y: 0 }, data: {} },
        ],
        [{ id: "e1", source: "note-1", target: "agent-1" }],
      ),
      "agent-1",
    );

    expect(sources).toEqual([{ type: "note", content: markdown, assets: [{ id: "asset_1", alt: "diagram" }] }]);
  });

  it("a critic after a critic reads the first critic's review, not empty input (#112)", () => {
    canvasHandoffStore.set("critic-a", { name: "Security review", summary: "VERDICT: PASS — tokens are hashed.", sessionId: "s1" });
    const sources = resolveUpstreamContext(
      flow(
        [
          { id: "critic-a", type: "critic", position: { x: 0, y: 0 }, data: { title: "Security review" } },
          { id: "critic-b", type: "critic", position: { x: 0, y: 0 }, data: { title: "Second opinion" } },
        ],
        [{ id: "e1", source: "critic-a", target: "critic-b" }],
      ),
      "critic-b",
    );
    expect(sources).toEqual([{ type: "handoff", name: "Security review", content: "VERDICT: PASS — tokens are hashed." }]);
  });

  it("a File Node hands the agent its path, not its contents", () => {
    const sources = resolveUpstreamContext(
      flow(
        [
          { id: "file-1", type: "file", position: { x: 0, y: 0 }, data: { path: "/repo/src/a.ts", viewport: { topLine: 4 } } },
          { id: "agent-1", type: "agent", position: { x: 0, y: 0 }, data: {} },
        ],
        [{ id: "e1", source: "file-1", target: "agent-1" }],
      ),
      "agent-1",
    );
    expect(sources).toEqual([{ type: "file", path: "/repo/src/a.ts" }]);
  });
});
