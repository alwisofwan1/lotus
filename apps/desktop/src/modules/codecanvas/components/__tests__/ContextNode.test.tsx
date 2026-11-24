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

vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({
  useCanvasLodTier: () => "full",
}));

vi.mock("@/modules/codecanvas/hooks/useContextBusArtifacts", () => ({
  useContextBusArtifacts: () => [],
}));

import { ContextNode } from "../nodes/ContextNode";
import type { CanvasContextNodeData } from "../../types/canvas";

function makeProps(overrides?: Partial<CanvasContextNodeData>) {
  return {
    id: "context-1",
    data: {
      title: "Context Bus",
      onClose: vi.fn(),
      onChange: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof ContextNode>[0];
}

describe("ContextNode", () => {
  it("emits context commands through the node command seam", () => {
    const dispatchCommand = vi.fn();
    render(<ContextNode {...makeProps({ dispatchCommand, onClose: undefined, onChange: undefined })} />);

    fireEvent.change(screen.getByLabelText("Context bus name"), { target: { value: "Findings" } });
    fireEvent.click(screen.getByRole("button", { name: "Close context node" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-context", nodeId: "context-1", patch: { title: "Findings" } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "context-1" });
  });
});
