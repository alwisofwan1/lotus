"use client";

import { ViewportPortal } from "@xyflow/react";
import type { Node } from "@xyflow/react";
import { useSyncExternalStore } from "react";
import { jumpLabelsStore, type JumpLabelsStore } from "../services/jump-labels-store";

/**
 * The letter badges, drawn over the cells they name (`plans/codecanvas-hotkeys/` S7).
 *
 * Rendered in flow coordinates through `ViewportPortal` so the badges track pan and zoom with the
 * nodes they belong to. Unlike the fleet rail, this genuinely is the case that pattern was written
 * for: badges are read, never clicked, so they stay out of the pointer's way entirely and need none
 * of ReactFlow's `nodrag nopan nowheel` opt-outs.
 *
 * Only labels still matching the typing are drawn. Half-typed badges disappearing is the feedback
 * that the first letter registered — without it a two-letter label gives no sign of progress.
 */

interface Props {
  nodes: Node[];
  store?: JumpLabelsStore;
}

export function CanvasJumpLabels({ nodes, store = jumpLabelsStore }: Props) {
  // Subscribed for the re-render, not the value: the snapshot is a fresh object every call, so it
  // could never be compared by reference. The version is the comparable thing.
  useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.version(),
    () => 0,
  );
  const snapshot = store.snapshot();

  if (!snapshot) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return (
    <ViewportPortal>
      {[...snapshot.labels.entries()].map(([label, nodeId]) => {
        if (!label.startsWith(snapshot.typed)) return null;
        const node = byId.get(nodeId);
        if (!node) return null;
        return (
          <span
            key={label}
            className="canvas-jump-label"
            data-testid={`jump-label-${nodeId}`}
            style={{ position: "absolute", left: node.position.x, top: node.position.y }}
          >
            {/* The part already typed stays visible but recedes, so the eye can see how far it got
                rather than having to remember. */}
            {snapshot.typed && (
              <span className="canvas-jump-label-done">{label.slice(0, snapshot.typed.length)}</span>
            )}
            {label.slice(snapshot.typed.length)}
          </span>
        );
      })}
    </ViewportPortal>
  );
}
