"use client";

import { Fragment, type ReactNode } from "react";
import { SplitHandle } from "@/modules/workspace-shell/components/SplitHandle";
import { resolveTrackSizes, toGridRows, trackDragDelta } from "@/modules/workspace-shell/services/grid-layout";
import { SPLIT_HANDLE_SIZE } from "@/modules/workspace-shell/services/split-sizing";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";

interface WorkspaceGridProps {
  workspace: Workspace;
  containerWidth: number;
  containerHeight: number;
  renderPane: (cell: GridCell) => ReactNode;
  onResizeColumn: (columnIndex: number, deltaPx: number, containerWidth: number) => void;
  onResizeRow: (rowIndex: number, deltaPx: number, containerHeight: number) => void;
}

const MIN_FRACTION_PX = 160;

/**
 * The workspace's panes, in the layout the workspace already has.
 *
 * Rows and columns come from `workspace.rows/cols` and their fractions — the same numbers
 * CodeSpace persists and the same ones its resize actions move. Dragging a seam here calls those
 * actions, so a width set in this shell survives a restart and means the same thing in both
 * surfaces. The shell owns no pane sizes of its own.
 */
export function WorkspaceGrid({
  workspace,
  containerWidth,
  containerHeight,
  renderPane,
  onResizeColumn,
  onResizeRow,
}: WorkspaceGridProps) {
  const rows = toGridRows(workspace.cells, workspace.rows, workspace.cols);
  const rowHeights = resolveTrackSizes(
    containerHeight,
    workspace.rowFractions ?? [],
    SPLIT_HANDLE_SIZE,
    MIN_FRACTION_PX,
  ).slice(0, rows.length);

  return (
    <div className="ws-grid">
      {rows.map((row, rowIndex) => {
        const colWidths = resolveTrackSizes(
          containerWidth,
          workspace.colFractions ?? [],
          SPLIT_HANDLE_SIZE,
          MIN_FRACTION_PX,
        ).slice(0, row.cells.length);
        const rowHeight = rowHeights[rowIndex];

        return (
          <Fragment key={row.index}>
            <div
              className="ws-row"
              style={rowHeight ? { height: rowHeight } : { flex: "1 1 0" }}
            >
              {row.cells.map((cell, columnIndex) => {
                const isLast = columnIndex === row.cells.length - 1;
                const width = colWidths[columnIndex];

                return (
                  <Fragment key={cell.id}>
                    <div
                      className={width ? "ws-pane-slot" : "ws-pane-slot ws-pane-slot--fill"}
                      style={width ? { width } : undefined}
                    >
                      {renderPane(cell)}
                    </div>
                    {!isLast && width ? (
                      <SplitHandle
                        orientation="vertical"
                        size={width}
                        min={MIN_FRACTION_PX}
                        max={Math.max(MIN_FRACTION_PX, containerWidth - MIN_FRACTION_PX)}
                        defaultSize={width}
                        label={`Resize column ${columnIndex + 1}`}
                        onResize={(next) => {
                          const drag = trackDragDelta({
                            currentSize: width,
                            nextSize: next,
                            containerSize: containerWidth,
                            trackCount: row.cells.length,
                            seamSize: SPLIT_HANDLE_SIZE,
                          });
                          onResizeColumn(columnIndex, drag.deltaPx, drag.containerSize);
                        }}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
            {rowIndex < rows.length - 1 && rowHeight ? (
              <SplitHandle
                orientation="horizontal"
                size={rowHeight}
                min={MIN_FRACTION_PX}
                max={Math.max(MIN_FRACTION_PX, containerHeight - MIN_FRACTION_PX)}
                defaultSize={rowHeight}
                label={`Resize row ${rowIndex + 1}`}
                onResize={(next) => {
                  const drag = trackDragDelta({
                    currentSize: rowHeight,
                    nextSize: next,
                    containerSize: containerHeight,
                    trackCount: rows.length,
                    seamSize: SPLIT_HANDLE_SIZE,
                  });
                  onResizeRow(rowIndex, drag.deltaPx, drag.containerSize);
                }}
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
