"use client";

import { Fragment, type ReactNode } from "react";
import { SplitHandle } from "@/modules/workspace-shell/components/SplitHandle";
import { useElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import { applySplitResize } from "@/modules/workspace-shell/services/split-tree-sizing";
import { resolveTrackSizes } from "@/modules/workspace-shell/services/grid-layout";
import { SPLIT_HANDLE_SIZE } from "@/modules/workspace-shell/services/split-sizing";
import type {
  TerminalV2LayoutNode,
  TerminalV2LayoutDirection,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";

export const SPLIT_MIN_PX = 180;

interface SplitTreeProps {
  node: TerminalV2LayoutNode;
  /** Where this node sits in the tree, as `resizeTerminalV2LayoutSplit` addresses it. */
  path: readonly number[];
  renderPane: (paneId: string) => ReactNode;
  onResize: (path: readonly number[], sizes: number[]) => void;
}

/**
 * The workspace's split tree, drawn.
 *
 * Every split node carries its own children and its own sizes, so every seam moves exactly one
 * pair of panes — which is what "resize per pane" means, as opposed to a row where one drag
 * shifts an entire column of them.
 *
 * Each node measures its OWN box rather than being handed one from above: a nested split does
 * not know how much room its parent gave it, and a size computed from the wrong box is how a
 * pane ends up overflowing its parent by exactly one seam.
 */
export function SplitTree({ node, path, renderPane, onResize }: SplitTreeProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();

  if (node.kind === "leaf") {
    return <div className="ws-split-leaf">{renderPane(node.paneId)}</div>;
  }

  const axis: TerminalV2LayoutDirection = node.direction;
  const containerPx = axis === "horizontal" ? size.width : size.height;
  const tracks = resolveTrackSizes(containerPx, node.sizes, SPLIT_HANDLE_SIZE, SPLIT_MIN_PX);
  const measured = tracks.length === node.children.length;

  return (
    <div className={`ws-split-node ws-split-node--${axis}`} ref={ref}>
      {node.children.map((child, index) => {
        const childPath = [...path, index];
        const trackPx = measured ? tracks[index] : undefined;
        const isLast = index === node.children.length - 1;

        return (
          <Fragment key={childPath.join("-")}>
            <div
              className="ws-split-track"
              style={
                trackPx === undefined
                  ? { flex: "1 1 0" }
                  : axis === "horizontal"
                    ? { width: Math.round(trackPx), flex: "0 0 auto" }
                    : { height: Math.round(trackPx), flex: "0 0 auto" }
              }
            >
              <SplitTree node={child} path={childPath} renderPane={renderPane} onResize={onResize} />
            </div>
            {!isLast && trackPx !== undefined ? (
              <SplitHandle
                orientation={axis === "horizontal" ? "vertical" : "horizontal"}
                size={trackPx}
                min={SPLIT_MIN_PX}
                max={Math.max(SPLIT_MIN_PX, containerPx - SPLIT_MIN_PX)}
                /*
                  The snap target is the EQUAL share, not the current size. Passing the current
                  size makes the handle snap the drag back to where it started, so a 100px pull
                  moved the seam six pixels — which read as "dragging barely works".
                */
                defaultSize={containerPx / node.children.length}
                label={`Resize pane ${childPath.join(".")}`}
                onResize={(next) =>
                  onResize(
                    path,
                    applySplitResize({
                      sizes: node.sizes,
                      index,
                      leadingPx: next,
                      containerPx,
                      minPx: SPLIT_MIN_PX,
                    }),
                  )
                }
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
