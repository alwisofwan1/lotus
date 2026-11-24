import type { CSSProperties } from "react";
import type { FactoryProgress } from "@/lib/tauri/graph-run";
import type { FactoryRunState } from "../services/factory-run";
import { factoryStageBar } from "../services/factory-progress";
import { DitherPixels } from "./FactoryDither";

/**
 * The seven stages of a run as one pixel strip (Factory round 5): texture is the step's status,
 * colour is the surface's. Shared by the Board card, the Runs row, Run detail, the issue card and the
 * canvas node; only the pixel size and the row count change between them.
 */
export function FactoryStageBar({
  progress,
  state,
  pixel = 3,
  rows = 3,
}: {
  progress: FactoryProgress | null;
  state: FactoryRunState;
  /** Side of one pixel, in CSS px. */
  pixel?: number;
  /** Pixel rows: the strip is `pixel × rows` tall. */
  rows?: number;
}) {
  return (
    <ol className="fa-bar" aria-label="Stages" style={{ "--fa-strip-h": `${pixel * rows}px` } as CSSProperties}>
      {factoryStageBar(progress, state).map((seg) => (
        <li key={seg.stage} className="fa-bar-seg" data-status={seg.status}>
          <span className="fa-seg-px">
            <DitherPixels status={seg.status} pixel={pixel} />
          </span>
          {seg.label}
        </li>
      ))}
    </ol>
  );
}
