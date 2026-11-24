import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasFrameDeleteDialog } from "../CanvasFrameDeleteDialog";

const summary = { nodeCount: 3, terminals: 1, agents: 1, memberIds: ["a", "b", "c"] };

describe("CanvasFrameDeleteDialog", () => {
  it("says it is not undoable and shows the running terminal count", () => {
    render(<CanvasFrameDeleteDialog frameTitle="Bug triage" summary={summary} onCancel={vi.fn()} onDeleteFrameOnly={vi.fn()} onDeleteAll={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("Bug triage");
    expect(screen.getByTestId("frame-delete-consequence")).toHaveTextContent("1 running terminal and 1 agent");
    expect(screen.getByTestId("frame-delete-consequence")).toHaveTextContent("cannot be brought back by Undo");
  });

  it("puts initial focus on Cancel and Escape cancels", () => {
    const onCancel = vi.fn();
    render(<CanvasFrameDeleteDialog frameTitle="F" summary={summary} onCancel={onCancel} onDeleteFrameOnly={vi.fn()} onDeleteAll={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("offers the safe alternative and the destructive action by name", () => {
    const onDeleteFrameOnly = vi.fn();
    const onDeleteAll = vi.fn();
    render(<CanvasFrameDeleteDialog frameTitle="F" summary={summary} onCancel={vi.fn()} onDeleteFrameOnly={onDeleteFrameOnly} onDeleteAll={onDeleteAll} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Frame only" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Frame + 3 nodes" }));
    expect(onDeleteFrameOnly).toHaveBeenCalledTimes(1);
    expect(onDeleteAll).toHaveBeenCalledTimes(1);
  });
});
