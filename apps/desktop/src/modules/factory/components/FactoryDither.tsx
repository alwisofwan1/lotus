import { useId } from "react";
import type { FactoryStageStatus } from "../services/factory-progress";
import { DITHER_FRONT, ditherTile, type DitherTile } from "../services/factory-dither";

/** A tile as an SVG pattern in user space, so pixels stay square however wide the box is. */
function Pattern({ id, tile, pixel }: { id: string; tile: DitherTile; pixel: number }) {
  const side = tile.size * pixel;
  return (
    <pattern id={id} width={side} height={side} patternUnits="userSpaceOnUse">
      {tile.on.map(([x, y]) => (
        <rect key={`${x}.${y}`} className="fa-seg-ink" x={x * pixel} y={y * pixel} width={pixel} height={pixel} />
      ))}
    </pattern>
  );
}

/**
 * One status's pixels, filling their box (round 5, "Dither steps"). The colours come from the
 * box's `--fa-seg-track` and `--fa-seg-ink`. The front is drawn twice across a 200%-wide SVG that
 * slides by half its width, so the march loops without a seam; at rest it shows the second copy.
 * Shared by the stage strip, the try cells and the Timeline's marks.
 */
export function DitherPixels({ status, pixel }: { status: FactoryStageStatus; pixel: number }) {
  // useId's punctuation is not safe inside url(#…).
  const id = `fa-px${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const texture = ditherTile(status);
  if (!texture) {
    const bands = DITHER_FRONT.length;
    return (
      <svg className="fa-seg-svg" data-front="" aria-hidden focusable="false">
        <defs>
          {DITHER_FRONT.map((t, i) => (
            <Pattern key={i} id={`${id}-${i}`} tile={t} pixel={pixel} />
          ))}
        </defs>
        <rect className="fa-seg-track" width="100%" height="100%" />
        {Array.from({ length: bands * 2 }, (_, i) => (
          <rect key={i} x={`${(i * 50) / bands}%`} width={`${50 / bands}%`} height="100%" fill={`url(#${id}-${i % bands})`} />
        ))}
      </svg>
    );
  }
  return (
    <svg className="fa-seg-svg" aria-hidden focusable="false">
      <defs>
        <Pattern id={id} tile={texture} pixel={pixel} />
      </defs>
      <rect className="fa-seg-track" width="100%" height="100%" />
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/** The Factory's empty states sit on a still field of dots (the "not run yet" texture), faded at the edges. */
export function EmptyDither() {
  return (
    <span className="fa-empty-art" aria-hidden>
      <DitherPixels status="todo" pixel={3} />
    </span>
  );
}
