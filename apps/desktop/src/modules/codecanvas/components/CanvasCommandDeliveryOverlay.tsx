"use client";
import { useEffect, useRef } from "react";
import type { CanvasCommandDeliveryEvent } from "../services/canvas-command-delivery";
import {
  buildFlightPath,
  cometFrame,
  cometHeadFade,
  DISPATCH_COMET_TAIL_SAMPLES,
  landingAnchor,
  quadraticPoint,
  rectCenter,
  type DispatchMotionMode,
  type FlightGeometry,
  type Point,
  type RectLike,
} from "../services/dispatch-comet";

const SOURCE_SELECTOR: Record<CanvasCommandDeliveryEvent["source"], string> = {
  "nl-command": "[data-canvas-delivery-source='nl-command']",
};

function selectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function readMotionMode(): DispatchMotionMode {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "reduced";
  }
  const shell = typeof document !== "undefined" ? document.querySelector(".codecanvas-shell") : null;
  if (shell?.getAttribute("data-canvas-motion") === "off") return "off";
  return "full";
}

function toRectLike(rect: DOMRect): RectLike {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function resolveRect(selector: string): { el: Element; rect: RectLike } | null {
  const el = typeof document !== "undefined" ? document.querySelector(selector) : null;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { el, rect: toRectLike(rect) };
}

/** 0 — anticipation spark at the command bar as the comet leaves. */
function drawCharge(ctx: CanvasRenderingContext2D, source: Point, alpha: number) {
  if (alpha <= 0.001) return;
  const radius = 5 + alpha * 15;
  const grd = ctx.createRadialGradient(source.x, source.y, 0, source.x, source.y, radius);
  grd.addColorStop(0, `rgba(224, 247, 255, ${0.9 * alpha})`);
  grd.addColorStop(0.4, `rgba(56, 189, 248, ${0.5 * alpha})`);
  grd.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(source.x, source.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * 1 — the comet: a white-hot head on the arc, trailed by the last N head positions drawn as a tapering
 * additively-blended polyline. Because the tail IS the recent path, it curves with the head — never a
 * rigid straight bar.
 */
function drawComet(ctx: CanvasRenderingContext2D, geo: FlightGeometry, progress: number, hist: Point[]) {
  const head = quadraticPoint(geo.source, geo.control, geo.target, progress);
  hist.push(head);
  if (hist.length > DISPATCH_COMET_TAIL_SAMPLES) hist.shift();

  // Dissolve the head over the final stretch so a steep descent melts into the impact, never a hard bar.
  const fade = cometHeadFade(progress);
  if (fade <= 0.001) return;

  // Restrained deterministic sparks make the travel leg legible on both light and dark Canvas
  // themes without introducing random animation state or the old DOM particle system.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 7; i++) {
    const trailProgress = Math.max(0, progress - 0.028 * (i + 1));
    const point = quadraticPoint(geo.source, geo.control, geo.target, trailProgress);
    const side = (i % 2 === 0 ? 1 : -1) * (1.5 + i * 0.45);
    const alpha = fade * (0.34 - i * 0.04);
    ctx.fillStyle = `rgba(125, 211, 252, ${Math.max(0.06, alpha)})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y + side, Math.max(0.7, 1.8 - i * 0.18), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // two passes: a wide faint bloom, then a brighter core streak (capped so it never fattens into a bar)
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 1; k < hist.length; k++) {
      const f = k / hist.length; // 0 = oldest → 1 = newest (at the head)
      const alpha = (pass === 0 ? 0.09 : 0.5) * f * f;
      const width = (pass === 0 ? 6.5 : 3.4) * f + 0.3;
      ctx.strokeStyle =
        pass === 0 ? `rgba(56, 189, 248, ${alpha})` : `rgba(125, 211, 252, ${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(hist[k - 1].x, hist[k - 1].y);
      ctx.lineTo(hist[k].x, hist[k].y);
      ctx.stroke();
    }
  }

  // head — outer glow + white-hot core, stretched gently along the velocity vector
  const ahead = quadraticPoint(geo.source, geo.control, geo.target, Math.min(1, progress + 0.02));
  const vx = ahead.x - head.x;
  const vy = ahead.y - head.y;
  const speed = Math.hypot(vx, vy);

  ctx.translate(head.x, head.y);
  ctx.rotate(Math.atan2(vy, vx));

  const outer = ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
  outer.addColorStop(0, "rgba(56, 189, 248, 0.45)");
  outer.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.scale(1 + Math.min(0.5, speed * 0.03), 1);
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 7);
  core.addColorStop(0, "rgba(255, 255, 255, 0.96)");
  core.addColorStop(0.4, "rgba(224, 247, 255, 0.9)");
  core.addColorStop(0.72, "rgba(125, 211, 252, 0.72)");
  core.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

/**
 * 2 — impact: a slim caret-width sweep on the input rail plus a caret flash. Proportional and
 * left-anchored to where the prompt actually is — never a radial bloom across the node centre.
 */
function drawImpact(ctx: CanvasRenderingContext2D, target: Point, sweepBasis: number, alpha: number) {
  if (alpha <= 0.001) return;
  const width = Math.min(sweepBasis * 0.6, 150) * alpha;
  const height = 3;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  const grd = ctx.createLinearGradient(target.x - 6, 0, target.x - 6 + width, 0);
  grd.addColorStop(0, `rgba(224, 247, 255, ${0.85 * alpha})`);
  grd.addColorStop(0.25, `rgba(125, 211, 252, ${0.5 * alpha})`);
  grd.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.fillStyle = grd;
  ctx.fillRect(target.x - 6, target.y - height / 2, width, height);

  const caretR = 12 * alpha + 4;
  const caret = ctx.createRadialGradient(target.x - 4, target.y, 0, target.x - 4, target.y, caretR);
  caret.addColorStop(0, `rgba(224, 247, 255, ${0.9 * alpha})`);
  caret.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.fillStyle = caret;
  ctx.beginPath();
  ctx.arc(target.x - 4, target.y, caretR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 3 — node acknowledgement: a single 1px accent border shimmer around the receiving node. */
function drawAck(ctx: CanvasRenderingContext2D, nodeRect: RectLike, alpha: number) {
  if (alpha <= 0.001) return;
  const r = 12;
  const x = nodeRect.left;
  const y = nodeRect.top;
  const w = nodeRect.width;
  const h = nodeRect.height;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = `rgba(56, 189, 248, ${0.55 * alpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

interface CanvasCommandDeliveryOverlayProps {
  deliveries: CanvasCommandDeliveryEvent[];
  onDeliveryComplete?: (id: string) => void;
}

interface Runtime {
  startedAt: number | null;
  hist: Point[];
  /**
   * The landing anchor frozen at flight start, as an offset within the target's node. The node rect is
   * still re-measured live each frame (so the landing follows auto-arrange / drag / zoom), but freezing
   * the in-node offset stops the terminal's caret jitter — the cursor row moves as the agent boots and
   * prints — from yanking the flight path around and streaking the tail.
   */
  anchor: { dx: number; dy: number; sweepBasis: number } | null;
  completed: boolean;
}

export function CanvasCommandDeliveryOverlay({ deliveries, onDeliveryComplete }: CanvasCommandDeliveryOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const deliveriesRef = useRef(deliveries);
  const runtimesRef = useRef<Map<string, Runtime>>(new Map());
  const hasDeliveries = deliveries.length > 0;

  // Keep the rAF loop reading the latest deliveries without restarting the loop each render.
  useEffect(() => {
    deliveriesRef.current = deliveries;
  }, [deliveries]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // no 2D support (e.g. jsdom) — geometry still resolves, there is just nothing to paint

    const runtimes = runtimesRef.current;
    let raf = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);

    const frame = (now: number) => {
      raf = window.requestAnimationFrame(frame);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      const active = deliveriesRef.current;
      const liveIds = new Set(active.map((delivery) => delivery.id));
      for (const id of [...runtimes.keys()]) if (!liveIds.has(id)) runtimes.delete(id);

      const mode = readMotionMode();

      for (const event of active) {
        let runtime = runtimes.get(event.id);
        if (!runtime) {
          runtime = { startedAt: null, hist: [], anchor: null, completed: false };
          runtimes.set(event.id, runtime);
        }

        // Source (command bar) is stable — re-measure live. Target: find the node live so the landing
        // follows auto-arrange/drag/zoom, but the caret offset within it is frozen (below) to stop
        // terminal cursor jitter from streaking the flight path.
        const src = resolveRect(SOURCE_SELECTOR[event.source]);
        const targetValue = selectorValue(event.targetNodeId);
        const tgtEl = typeof document !== "undefined"
          ? document.querySelector(`[data-canvas-command-delivery-target="${targetValue}"]`)
            ?? document.querySelector(`[data-canvas-agent-delivery-target="${targetValue}"]`)
            ?? document.querySelector(`.react-flow__node[data-id="${targetValue}"] .canvas-node`)
          : null;
        if (!src || !tgtEl) continue; // not placeable yet — retry next frame

        const nodeEl = tgtEl.closest(".canvas-node");
        const nodeRect = nodeEl ? toRectLike(nodeEl.getBoundingClientRect()) : null;

        // Freeze the landing anchor as an in-node offset, once, on the first resolvable frame.
        if (!runtime.anchor) {
          const tgtRect = toRectLike(tgtEl.getBoundingClientRect());
          if (tgtRect.width <= 0 || tgtRect.height <= 0) continue;
          const landing = landingAnchor(tgtRect);
          const base = nodeRect ?? tgtRect;
          runtime.anchor = { dx: landing.x - base.left, dy: landing.y - base.top, sweepBasis: tgtRect.width };
          runtime.startedAt = now;
        }

        const elapsed = now - (runtime.startedAt ?? now);
        const cf = cometFrame(elapsed, mode);
        if (cf.done) {
          if (!runtime.completed) {
            runtime.completed = true;
            onDeliveryComplete?.(event.id);
          }
          continue;
        }

        const base = nodeRect ?? toRectLike(tgtEl.getBoundingClientRect());
        const target = { x: base.left + runtime.anchor.dx, y: base.top + runtime.anchor.dy };
        const geo = buildFlightPath(rectCenter(src.rect), target);

        drawCharge(ctx, geo.source, cf.charge);
        if (cf.flight != null) {
          drawComet(ctx, geo, cf.flight, runtime.hist);
        } else {
          runtime.hist.length = 0;
        }
        drawImpact(ctx, target, runtime.anchor.sweepBasis, cf.impact);
        if (nodeRect) drawAck(ctx, nodeRect, cf.ack);
      }
    };
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      runtimes.clear();
    };
  }, [hasDeliveries, onDeliveryComplete]);

  if (!hasDeliveries) return null;

  return (
    <canvas
      ref={canvasRef}
      className="canvas-command-delivery-overlay"
      data-testid="canvas-command-delivery-overlay"
      aria-hidden
    />
  );
}
