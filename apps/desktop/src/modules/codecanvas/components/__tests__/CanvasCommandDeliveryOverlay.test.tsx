import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasCommandDeliveryOverlay } from "../CanvasCommandDeliveryOverlay";
import type { CanvasCommandDeliveryEvent } from "../../services/canvas-command-delivery";

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function zIndex(rule: string): number {
  const match = rule.match(/z-index:\s*(\d+)/);
  expect(match).not.toBeNull();
  return Number(match?.[1] ?? 0);
}

const DELIVERY_CSS = () => readFileSync(resolve(process.cwd(), "src/styles/canvas/command-delivery.css"), "utf8");

const delivery: CanvasCommandDeliveryEvent = {
  id: "delivery-1",
  source: "nl-command",
  targetNodeId: "a-nova",
  outcome: "delivered",
  commandPreview: "fix lint errors",
  createdAt: 1,
};

function renderOverlay(deliveries: CanvasCommandDeliveryEvent[], onDeliveryComplete?: (id: string) => void) {
  return render(
    <div>
      <div data-canvas-delivery-source="nl-command" />
      <div className="canvas-node">
        <div data-canvas-command-delivery-target="a-nova" />
      </div>
      <CanvasCommandDeliveryOverlay deliveries={deliveries} onDeliveryComplete={onDeliveryComplete} />
    </div>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("CanvasCommandDeliveryOverlay", () => {
  it("paints the dispatch effect onto a single full-overlay canvas", () => {
    renderOverlay([delivery]);
    const overlay = screen.getByTestId("canvas-command-delivery-overlay");
    expect(overlay.tagName).toBe("CANVAS");
    expect(overlay).toHaveClass("canvas-command-delivery-overlay");
    expect(overlay).toHaveAttribute("aria-hidden");
  });

  it("paints a generic Canvas node delivery through the real Canvas 2D seam", () => {
    const frames: FrameRequestCallback[] = [];
    const gradient = { addColorStop: vi.fn() };
    const ctx = {
      setTransform: vi.fn(), clearRect: vi.fn(), createRadialGradient: vi.fn(() => gradient),
      createLinearGradient: vi.fn(() => gradient), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(),
      arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), translate: vi.fn(),
      rotate: vi.fn(), scale: vi.fn(), fillRect: vi.fn(), arcTo: vi.fn(), closePath: vi.fn(),
      globalCompositeOperation: "source-over", fillStyle: "", strokeStyle: "", lineWidth: 1,
      globalAlpha: 1, lineCap: "butt", lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const onDeliveryComplete = vi.fn();
    const { container } = renderOverlay([delivery], onDeliveryComplete);
    const source = container.querySelector("[data-canvas-delivery-source='nl-command']") as HTMLElement;
    const target = container.querySelector("[data-canvas-command-delivery-target='a-nova']") as HTMLElement;
    const node = target.closest(".canvas-node") as HTMLElement;
    source.getBoundingClientRect = () => rect(10, 700, 360, 44);
    target.getBoundingClientRect = () => rect(760, 220, 420, 36);
    node.getBoundingClientRect = () => rect(740, 160, 460, 320);

    act(() => {
      frames.shift()?.(100);
      frames.shift()?.(500);
      frames.shift()?.(900);
      frames.shift()?.(1_400);
    });

    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
    expect(vi.mocked(ctx.arc).mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(onDeliveryComplete).toHaveBeenCalledOnce();
    expect(onDeliveryComplete).toHaveBeenCalledWith("delivery-1");
  });

  it("renders nothing when there is no delivery in flight", () => {
    renderOverlay([]);
    expect(screen.queryByTestId("canvas-command-delivery-overlay")).toBeNull();
  });

  it("carries no legacy DOM-span layers, SVG, or animateMotion — the effect is fully canvas-drawn", () => {
    const { container } = renderOverlay([delivery]);
    for (const legacy of [
      ".canvas-command-delivery-charge",
      ".canvas-command-delivery-packet",
      ".canvas-command-delivery-landing",
      ".canvas-command-delivery-tracer",
      ".canvas-command-delivery-route",
      ".canvas-command-delivery-receive",
      ".canvas-command-delivery-comet",
      ".canvas-command-delivery-comet-tail",
      ".canvas-command-delivery-ack",
      ".canvas-command-delivery-target-lock",
    ]) {
      expect(container.querySelector(legacy)).toBeNull();
    }
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("animateMotion")).toBeNull();
  });

  it("keeps delivery feedback above the NL command bar layer", () => {
    const deliveryCss = DELIVERY_CSS();
    const commandBarCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/agent-node-persona-nl.css"), "utf8");
    expect(zIndex(cssRule(deliveryCss, ".canvas-command-delivery-overlay"))).toBeGreaterThan(
      zIndex(cssRule(commandBarCss, ".canvas-nl-bar")),
    );
  });

  it("makes the overlay a fixed, click-through canvas", () => {
    const rule = cssRule(DELIVERY_CSS(), ".canvas-command-delivery-overlay");
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/inset:\s*0/);
  });

  it("cursor-tracks the live-agent anchor — no fixed bottom offset (the caret sits above the TUI footer)", () => {
    const rule = cssRule(DELIVERY_CSS(), ".canvas-live-agent-delivery-target");
    expect(rule).toMatch(/position:\s*absolute/);
    // LiveAgentNode sets top/height at runtime from the xterm cursor row …
    expect(rule).not.toMatch(/bottom:\s*0/);
    // …and no longer floats at the old hardcoded guess
    expect(rule).not.toMatch(/bottom:\s*5\.65rem/);
  });
});
