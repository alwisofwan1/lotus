import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => null,
  };
});

vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => "full" }));

import { HumanGateNode } from "../nodes/HumanGateNode";
import { agentRunRegistry } from "../../services/agent-run-registry";
import type { CanvasHumanGateNodeData } from "../../types/canvas";

function makeProps(overrides?: Partial<CanvasHumanGateNodeData>) {
  return {
    id: "gate-1",
    data: {
      title: "Approve release",
      instructions: "Check the diff before release.",
      gateKind: "approval",
      status: "idle",
      onClose: vi.fn(),
      onChange: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof HumanGateNode>[0];
}

describe("HumanGateNode", () => {
  it("emits human-gate commands through the node command seam", () => {
    const dispatchCommand = vi.fn();
    render(<HumanGateNode {...makeProps({ dispatchCommand, onClose: undefined, onChange: undefined })} />);

    fireEvent.change(screen.getByLabelText("Human gate title"), { target: { value: "Approve deploy" } });
    fireEvent.change(screen.getByLabelText("Human gate instructions"), { target: { value: "Verify smoke tests." } });
    fireEvent.click(screen.getByRole("button", { name: "Close human gate" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-human-gate", nodeId: "gate-1", patch: { title: "Approve deploy" } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-human-gate", nodeId: "gate-1", patch: { instructions: "Verify smoke tests." } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "gate-1" });
  });

  it("records when it starts waiting and clears it with the decision", () => {
    const dispatchCommand = vi.fn();
    const results: unknown[] = [];
    const unsubscribe = agentRunRegistry.subscribeResults((id, ok, result) => results.push({ id, ok, gate: result?.gate }));
    vi.spyOn(Date, "now").mockReturnValue(42_000);
    const { rerender } = render(<HumanGateNode {...makeProps({ dispatchCommand })} />);

    agentRunRegistry.run("gate-1", { graphRunId: null, upstreamIds: [] });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-human-gate", nodeId: "gate-1", patch: { status: "waiting", waitingSince: 42_000 } });

    rerender(<HumanGateNode {...makeProps({ dispatchCommand, status: "waiting", waitingSince: 42_000 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(dispatchCommand).toHaveBeenLastCalledWith({ kind: "patch-human-gate", nodeId: "gate-1", patch: { status: "rejected", waitingSince: undefined } });
    expect(results).toEqual([{ id: "gate-1", ok: false, gate: "fail" }]);
    unsubscribe();
    vi.restoreAllMocks();
  });
});
