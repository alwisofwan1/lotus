"use client";
import { memo, useCallback, useEffect, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { FactoryRunNodeCard, factoryIssueTitle, useFactoryRunRow } from "@/modules/factory";
import { requestDockFactoryRun } from "../../services/dock-factory-request";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeGlyph, type CanvasGlyphTone } from "./CanvasNodeGlyph";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import type { CanvasFactoryNodeData } from "../../types/canvas";

const GROUP_TONE: Record<string, CanvasGlyphTone> = {
  working: "active",
  // The glyph has no attention tone; `pending` is the nearest, as for an agent that needs you.
  "needs-you": "pending",
  ready: "done",
  done: "done",
  stopped: "neutral",
};

/**
 * One GitHub issue's Factory Run on the canvas (#146). Everything it draws comes from the Factory
 * module's public index; the canvas adds only the frame, the zoomed-out glyph, and where a
 * double-click goes: the Canvas Dock's Factory, on that run (S3) — the canvas stays put.
 */
export const FactoryNode = memo(function FactoryNode({ data, selected }: NodeProps) {
  const { repo, issue, title } = data as CanvasFactoryNodeData;
  const lodTier = useCanvasLodTier();
  const { row, loading } = useFactoryRunRow(repo, issue);
  const now = useNow(row?.group === "working" && lodTier === "full");
  const open = useCallback(() => requestDockFactoryRun({ repo, issue }), [repo, issue]);

  return (
    <CanvasNodeFrame
      kind="factory"
      selected={!!selected}
      minWidth={280}
      minHeight={160}
      header={null}
      lodTier={lodTier}
      statusTone={row?.group === "working" ? "running" : "idle"}
      glyph={<CanvasNodeGlyph label={factoryIssueTitle(issue, row?.title ?? title)} tone={GROUP_TONE[row?.group ?? "stopped"]} detail="Factory" />}
    >
      <FactoryRunNodeCard row={row} saved={{ issue, title }} now={now} loading={loading} onOpen={open} />
    </CanvasNodeFrame>
  );
});

/** A display clock: ticks each second only while a working run is legible. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
