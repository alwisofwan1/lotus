import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { describeCanvasNode } from "../canvas-node-view";

const node = (input: Partial<Node> & Pick<Node, "id" | "type">): Node => ({
  position: { x: 0, y: 0 },
  data: {},
  ...input,
} as Node);

describe("describeCanvasNode", () => {
  it("gives terminals a stable numbered identity instead of duplicating the repository name", () => {
    expect(describeCanvasNode(node({ id: "t1", type: "terminal", data: { cwd: "/repo/app", terminalNumber: 3 } }), 0)).toMatchObject({
      label: "Terminal 3",
      detail: "app",
      type: "terminal",
    });
  });

  it("uses a terminal's custom label while keeping its repository as context", () => {
    expect(describeCanvasNode(node({ id: "t1", type: "terminal", data: { cwd: "/repo/app", terminalNumber: 3, label: "API server" } }), 0)).toMatchObject({
      label: "API server",
      detail: "Terminal 3 · app",
      type: "terminal",
    });
  });

  it("surfaces agent model and live status", () => {
    expect(describeCanvasNode(
      node({ id: "a1", type: "agent", data: { name: "Frontend Engineer", model: "claude-sonnet-4-6" } }),
      1,
      { id: "a1", name: "Frontend Engineer", status: "running" },
    )).toMatchObject({
      label: "Frontend Engineer",
      detail: "claude-sonnet-4-6",
      status: "running",
      type: "agent",
    });
  });

  it("describes production-only canvas nodes beyond terminals and notes", () => {
    expect(describeCanvasNode(node({ id: "c1", type: "context", data: { title: "Shared Findings" } }), 2)).toMatchObject({ label: "Shared Findings", detail: "context bus" });
    expect(describeCanvasNode(node({ id: "k1", type: "critic", data: { title: "Security Gate", model: "claude-opus-4-8" } }), 3)).toMatchObject({ label: "Security Gate", detail: "claude-opus-4-8" });
    expect(describeCanvasNode(node({ id: "task1", type: "task", data: { title: "Ship inspector", status: "in-progress", priority: "high" } }), 4)).toMatchObject({ label: "Ship inspector", detail: "task · in-progress · high" });
  });
});
