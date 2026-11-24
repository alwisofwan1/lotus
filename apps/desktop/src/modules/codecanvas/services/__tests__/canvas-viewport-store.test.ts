import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canvasViewportZoomBoundsForNodeCount,
  loadCanvasViewport,
  saveCanvasViewport,
  viewportForCanvasProject,
} from "../canvas-viewport-store";

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) { return this.store[key] ?? null; }
  setItem(key: string, value: string) { this.store[key] = String(value); }
  removeItem(key: string) { delete this.store[key]; }
  clear() { this.store = {}; }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new LocalStorageMock());
});

describe("canvas viewport store", () => {
  it("returns flat Miro-like zoom bounds regardless of node count", () => {
    expect(canvasViewportZoomBoundsForNodeCount(0)).toEqual({ minZoom: 0.01, maxZoom: 20 });
    expect(canvasViewportZoomBoundsForNodeCount(2)).toEqual({ minZoom: 0.01, maxZoom: 20 });
    expect(canvasViewportZoomBoundsForNodeCount(6)).toEqual({ minZoom: 0.01, maxZoom: 20 });
    expect(canvasViewportZoomBoundsForNodeCount(10)).toEqual({ minZoom: 0.01, maxZoom: 20 });
    expect(canvasViewportZoomBoundsForNodeCount(13)).toEqual({ minZoom: 0.01, maxZoom: 20 });
    expect(canvasViewportZoomBoundsForNodeCount(50)).toEqual({ minZoom: 0.01, maxZoom: 20 });
  });

  it("keeps board and Fleet viewport positions independent for one project", () => {
    saveCanvasViewport("project-a", { x: -120, y: 80, zoom: 0.9 }, undefined, "board");
    saveCanvasViewport("project-a", { x: 40, y: -20, zoom: 1.1 }, undefined, "fleet");

    expect(loadCanvasViewport("project-a", undefined, "board")).toEqual({ x: -120, y: 80, zoom: 0.9 });
    expect(loadCanvasViewport("project-a", undefined, "fleet")).toEqual({ x: 40, y: -20, zoom: 1.1 });
  });

  it("persists viewport by Canvas Project id", () => {
    saveCanvasViewport("project-a", { x: -120, y: 80, zoom: 0.9 });

    expect(loadCanvasViewport("project-a")).toEqual({ x: -120, y: 80, zoom: 0.9 });
    expect(loadCanvasViewport("project-b")).toBeNull();
  });

  it("clamps saved zoom to the 1%–2000% range", () => {
    saveCanvasViewport("project-a", { x: -120, y: 80, zoom: 0.0001 });
    saveCanvasViewport("project-b", { x: 24, y: -40, zoom: 25 });

    expect(loadCanvasViewport("project-a")).toEqual({ x: -120, y: 80, zoom: 0.01 });
    expect(loadCanvasViewport("project-b")).toEqual({ x: 24, y: -40, zoom: 20 });
  });

  it("clamps legacy stored zoom values when loading", () => {
    localStorage.setItem("lotus.codecanvas.viewport.project-a", JSON.stringify({ x: 8, y: 12, zoom: 0.005 }));
    localStorage.setItem("lotus.codecanvas.viewport.project-b", JSON.stringify({ x: -16, y: 24, zoom: 30 }));

    expect(loadCanvasViewport("project-a")).toEqual({ x: 8, y: 12, zoom: 0.01 });
    expect(loadCanvasViewport("project-b")).toEqual({ x: -16, y: 24, zoom: 20 });
  });

  it("uses dynamic Canvas Project zoom bounds when provided", () => {
    const denseBounds = canvasViewportZoomBoundsForNodeCount(10);
    saveCanvasViewport("project-a", { x: 8, y: 12, zoom: 0.56 }, denseBounds);
    localStorage.setItem("lotus.codecanvas.viewport.project-b", JSON.stringify({ x: -16, y: 24, zoom: 0.56 }));

    expect(loadCanvasViewport("project-a", denseBounds)).toEqual({ x: 8, y: 12, zoom: 0.56 });
    expect(loadCanvasViewport("project-b", denseBounds)).toEqual({ x: -16, y: 24, zoom: 0.56 });
  });

  it("falls back to the default viewport when there is no saved project viewport", () => {
    expect(viewportForCanvasProject("missing")).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("ignores corrupt or incomplete stored values", () => {
    localStorage.setItem("lotus.codecanvas.viewport.project-a", JSON.stringify({ x: 1, y: "bad", zoom: 1 }));

    expect(loadCanvasViewport("project-a")).toBeNull();
  });
});
