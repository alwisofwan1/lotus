/**
 * Measure the on-screen width (px) of one line of diagram-label text, so {@link layoutDiagram}
 * can size boxes to their content. Uses a cached offscreen 2D context in the browser; falls back
 * to a monospace-ish estimate when no canvas is available (SSR / tests), so callers never crash.
 */
const DIAGRAM_FONT = "500 14px ui-sans-serif, system-ui, -apple-system, sans-serif";
const FALLBACK_CHAR_PX = 7.2;

let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    if (typeof document === "undefined") return (ctx = null);
    const canvas = document.createElement("canvas");
    const c = canvas.getContext("2d");
    if (c) c.font = DIAGRAM_FONT;
    return (ctx = c);
  } catch {
    return (ctx = null);
  }
}

export function measureDiagramLabel(text: string): number {
  const c = context();
  if (!c) return text.length * FALLBACK_CHAR_PX;
  return c.measureText(text).width;
}
