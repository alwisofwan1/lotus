import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => null,
  };
});

vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({
  useCanvasLodTier: () => "full",
}));

vi.mock("@/modules/codecanvas/hooks/useCanvasGraphRun", () => ({
  useCanvasGraphRun: () => ({
    running: false,
    error: null,
    run: vi.fn(),
    resumable: null,
    resume: vi.fn(),
    replayFrom: vi.fn(),
    replayable: false,
    latestRun: null,
    lastSummary: null,
  }),
}));

vi.mock("@/lib/tauri/project-files", () => ({
  readProjectFile: vi.fn(),
}));

import { PlanNode } from "../nodes/PlanNode";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import type { CanvasPlanNodeData } from "../../types/canvas";

function makeProps(overrides?: Partial<CanvasPlanNodeData>) {
  return {
    id: "plan-1",
    data: {
      title: "Plan",
      cwd: "/repo",
      steps: [{ title: "Build", owner: "Lead" }],
      ownerBindings: {},
      onClose: vi.fn(),
      onPlanChange: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof PlanNode>[0];
}

afterEach(() => {
  agentStatusRegistry.remove("agent-1");
});

describe("PlanNode", () => {
  it("emits plan commands through the node command seam", () => {
    agentStatusRegistry.publish({ id: "agent-1", name: "Coder", status: "idle" });
    const dispatchCommand = vi.fn();
    render(<PlanNode {...makeProps({ dispatchCommand, onClose: undefined, onPlanChange: undefined })} />);

    fireEvent.change(screen.getByLabelText("Owner for Lead"), { target: { value: "agent-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Plan" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-plan", nodeId: "plan-1", patch: { ownerBindings: { Lead: "agent-1" } } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "plan-1" });
  });
});
