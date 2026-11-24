import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import { WorkspaceGrid } from "@/modules/workspace-shell/components/WorkspaceGrid";
import { SPLIT_HANDLE_SIZE } from "@/modules/workspace-shell/services/split-sizing";

function cell(id: string): GridCell {
  return { id, cwd: "/tmp", type: "terminal", runtimeSessionId: null, runtimeStatus: "idle" };
}

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: "w1",
    label: "Workspace",
    color: "#fff",
    cwd: "/tmp",
    rows: 1,
    cols: 1,
    rowFractions: [1],
    colFractions: [1],
    cells: [cell("a")],
    ...overrides,
  } as Workspace;
}

function renderGrid(ws: Workspace, width = 1000, height = 800) {
  const onResizeColumn = vi.fn();
  const onResizeRow = vi.fn();
  render(
    <WorkspaceGrid
      workspace={ws}
      containerWidth={width}
      containerHeight={height}
      renderPane={(paneCell) => <div data-testid={`pane-${paneCell.id}`} />}
      onResizeColumn={onResizeColumn}
      onResizeRow={onResizeRow}
    />,
  );
  return { onResizeColumn, onResizeRow };
}

function slotWidths(): number[] {
  return [...document.querySelectorAll<HTMLElement>(".ws-row > .ws-pane-slot")].map((slot) =>
    Number.parseFloat(slot.style.width || "0"),
  );
}

describe("WorkspaceGrid", () => {
  it("fits two columns and their seam inside the row, instead of overflowing it", () => {
    renderGrid(workspace({ cols: 2, colFractions: [0.5, 0.5], cells: [cell("a"), cell("b")] }), 1000);

    const widths = slotWidths();
    expect(widths).toHaveLength(2);
    // The bug this replaces: each column took half of 1000, so the row needed 1000 + one seam.
    expect(widths[0] + widths[1] + SPLIT_HANDLE_SIZE).toBeCloseTo(1000, 1);
  });
});

describe("WorkspaceGrid — rows", () => {
  const twoRows = workspace({
    rows: 2,
    cols: 1,
    rowFractions: [0.5, 0.5],
    colFractions: [1],
    cells: [cell("a"), cell("b")],
  });

  it("fits two rows and their seam inside the column", () => {
    renderGrid(twoRows, 1000, 800);

    const heights = [...document.querySelectorAll<HTMLElement>(".ws-grid > .ws-row")].map((row) =>
      Number.parseFloat(row.style.height || "0"),
    );
    expect(heights).toHaveLength(2);
    expect(heights[0] + heights[1] + SPLIT_HANDLE_SIZE).toBeCloseTo(800, 1);
  });

  it("offers a horizontal seam between the rows and resizes the row it sits under", () => {
    const { onResizeRow } = renderGrid(twoRows, 1000, 800);

    const seam = screen.getByRole("separator", { name: "Resize row 1" });
    expect(seam.className).toContain("ws-split--horizontal");

    // Dragging it must move ROW 0, with the height the rows actually share (800 − one seam).
    seam.focus();
    fireEvent.keyDown(seam, { key: "ArrowDown" });
    expect(onResizeRow).toHaveBeenCalledWith(0, expect.any(Number), 790);
  });
});
