import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => null,
    useReactFlow: () => ({ getEdges: () => [], getNode: () => null }),
  };
});

vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => "full" }));
const agentState = vi.hoisted(() => ({ opts: null as null | { onRunComplete: (record: Record<string, unknown>) => void } }));
vi.mock("@/modules/codecanvas/hooks/useAgentNodeState", () => ({
  useAgentNodeState: (opts: typeof agentState.opts) => {
    agentState.opts = opts;
    return { status: "idle", start: vi.fn(), stop: vi.fn() };
  },
}));
vi.mock("@/modules/codecanvas/hooks/useAgentRunRegistration", () => ({ useAgentRunRegistration: vi.fn() }));

import { CriticNode } from "../nodes/CriticNode";
import { canvasHandoffStore } from "../../services/canvas-handoff-store";
import type { CanvasCriticNodeData } from "../../types/canvas";

function makeProps(overrides?: Partial<CanvasCriticNodeData>) {
  return {
    id: "critic-1",
    data: {
      title: "Critic",
      cwd: "/repo",
      model: "claude-sonnet",
      onClose: vi.fn(),
      onChange: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof CriticNode>[0];
}

describe("CriticNode", () => {
  it("emits critic commands through the node command seam", () => {
    const dispatchCommand = vi.fn();
    render(<CriticNode {...makeProps({ dispatchCommand, onClose: undefined, onChange: undefined })} />);

    fireEvent.change(screen.getByLabelText("Critic name"), { target: { value: "Verifier" } });
    fireEvent.click(screen.getByRole("button", { name: "Close critic node" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-critic", nodeId: "critic-1", patch: { title: "Verifier" } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "critic-1" });
  });

  it("hands its review to whatever is wired after it, so a critic after a critic has input (#112)", () => {
    render(<CriticNode {...makeProps({ title: "Security review" })} />);
    agentState.opts!.onRunComplete({ id: "run-1", outcome: "completed", summary: "VERDICT: PASS — no secrets logged.", sessionId: "s1" });
    expect(canvasHandoffStore.get("critic-1")).toMatchObject({ name: "Security review", summary: "VERDICT: PASS — no secrets logged.", sessionId: "s1" });
  });

  it("a stopped run hands nothing over", () => {
    render(<CriticNode {...makeProps({ title: "Critic" })} />);
    const before = canvasHandoffStore.get("critic-1");
    agentState.opts!.onRunComplete({ id: "run-2", outcome: "stopped", summary: "half a review", sessionId: null });
    expect(canvasHandoffStore.get("critic-1")).toBe(before);
  });
});
