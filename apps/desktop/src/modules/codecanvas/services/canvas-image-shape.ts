import type { CanvasImageRef } from "./canvas-intake";

/**
 * Sizing + placement for a pasted/dropped image that becomes a first-class whiteboard image
 * shape (Excalidraw-style) instead of a Note attachment. The clamp is pure and unit-tested;
 * the placement orchestration takes injected effects (persist / measure / addShape) so it can
 * be exercised without Tauri or the DOM.
 */

export interface ImageBoxSize {
  w: number;
  h: number;
}

export interface ClampImageOptions {
  /** Longest edge of the display box, in flow px. */
  max: number;
  /** Box to use when the natural size is unknown or degenerate. */
  fallback?: ImageBoxSize;
}

const DEFAULT_FALLBACK: ImageBoxSize = { w: 320, h: 240 };

/**
 * Fit an image's natural dimensions into a `max × max` box, preserving aspect ratio and never
 * upscaling beyond the image's own size. Unknown/degenerate input yields the fallback box.
 */
export function clampImageDisplaySize(
  natural: { width: number; height: number } | null | undefined,
  opts: ClampImageOptions,
): ImageBoxSize {
  const fallback = opts.fallback ?? DEFAULT_FALLBACK;
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) return { ...fallback };
  const scale = Math.min(1, opts.max / Math.max(natural.width, natural.height));
  return {
    w: Math.round(natural.width * scale),
    h: Math.round(natural.height * scale),
  };
}

/** The impure surface `placeImageShapes` drives — supplied by the container (Tauri + React Flow). */
export interface ImageShapePlacementDeps {
  /** Write bytes/path to the note-asset store; returns the durable `lotus-note-asset://` URI + alt. */
  persist: (image: CanvasImageRef) => Promise<{ uri: string; alt: string }>;
  /** Read the image's intrinsic dimensions (loads it); null when unavailable. */
  measure: (assetUri: string) => Promise<{ width: number; height: number } | null>;
  /** Append an image shape node to the canvas; returns its node id. */
  addShape: (opts: {
    assetUri: string;
    alt: string;
    naturalWidth?: number;
    naturalHeight?: number;
    size: ImageBoxSize;
    position: { x: number; y: number };
  }) => string;
}

/** Offset between cascaded images so a multi-image paste doesn't land exactly overlapping. */
const CASCADE_STEP = 28;

/**
 * Persist each image, size it, and add it as an image shape at `origin` (cascading multiples).
 * Returns the created node ids in order; an image that fails to persist is skipped, not fatal.
 */
export async function placeImageShapes(
  images: CanvasImageRef[],
  origin: { x: number; y: number },
  deps: ImageShapePlacementDeps,
  opts: ClampImageOptions,
): Promise<string[]> {
  const ids: string[] = [];
  let placed = 0;
  for (const image of images) {
    let saved: { uri: string; alt: string };
    try {
      saved = await deps.persist(image);
    } catch {
      continue;
    }
    const natural = await deps.measure(saved.uri).catch(() => null);
    const size = clampImageDisplaySize(natural, opts);
    const position = { x: origin.x + placed * CASCADE_STEP, y: origin.y + placed * CASCADE_STEP };
    ids.push(deps.addShape({
      assetUri: saved.uri,
      alt: saved.alt,
      ...(natural ? { naturalWidth: natural.width, naturalHeight: natural.height } : {}),
      size,
      position,
    }));
    placed += 1;
  }
  return ids;
}
