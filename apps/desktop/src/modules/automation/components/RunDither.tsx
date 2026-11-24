import { ORB_FRAMES, ORB_SIDE, cometPixels, orbFrame, orbTrack, pixelPath } from "../services/run-dither";

// Computed once: the frames never change, only which one shows.
const FRAMES = Array.from({ length: ORB_FRAMES }, (_, i) => pixelPath(orbFrame(i)));
const TRACK = pixelPath(orbTrack());
const COMET_W = 120;
const COMET_H = 2;
const COMET = pixelPath(cometPixels(COMET_W, COMET_H));

/**
 * A run at work, as pixels: every frame of the orb is drawn, and CSS shows one at a time
 * (`.au-orb-frame`, each a frame's worth of delay behind the last). Reduced motion holds frame 0.
 */
export function DitherOrb({ pixel = 2 }: { pixel?: number }) {
  const side = ORB_SIDE * pixel;
  return (
    <svg className="au-orb" width={side} height={side} viewBox={`0 0 ${ORB_SIDE} ${ORB_SIDE}`} aria-hidden focusable="false">
      <path className="au-orb-track" d={TRACK} />
      {FRAMES.map((d, i) => (
        <path key={i} className="au-orb-frame" d={d} style={{ animationDelay: `${(i - ORB_FRAMES) * 80}ms` }} />
      ))}
    </svg>
  );
}

/** The comet that marches along an expanded run's card, 2px pixels; it stands still under reduced motion. */
export function DitherStrip() {
  return (
    <div className="au-strip" aria-hidden>
      <svg className="au-strip-comet" width={COMET_W * 2} height={COMET_H * 2} viewBox={`0 0 ${COMET_W} ${COMET_H}`} focusable="false">
        <path d={COMET} />
      </svg>
    </div>
  );
}
