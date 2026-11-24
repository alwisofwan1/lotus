import { describe, expect, it, vi } from "vitest";
import { clampImageDisplaySize, placeImageShapes, type ImageShapePlacementDeps } from "../canvas-image-shape";
import type { CanvasImageRef } from "../canvas-intake";

describe("clampImageDisplaySize", () => {
  it("scales a large landscape image down to the max long edge, preserving aspect", () => {
    const size = clampImageDisplaySize({ width: 1600, height: 900 }, { max: 480 });
    expect(size.w).toBe(480);
    expect(size.h).toBe(270); // 900 * (480/1600)
  });

  it("scales a large portrait image so its long edge (height) hits the max", () => {
    const size = clampImageDisplaySize({ width: 900, height: 1600 }, { max: 480 });
    expect(size.h).toBe(480);
    expect(size.w).toBe(270);
  });

  it("never upscales an image smaller than the max box — keeps natural size", () => {
    expect(clampImageDisplaySize({ width: 320, height: 200 }, { max: 480 })).toEqual({ w: 320, h: 200 });
  });

  it("falls back to a sane default box when natural size is unknown/degenerate", () => {
    expect(clampImageDisplaySize(null, { max: 480, fallback: { w: 320, h: 240 } })).toEqual({ w: 320, h: 240 });
    expect(clampImageDisplaySize({ width: 0, height: 0 }, { max: 480, fallback: { w: 320, h: 240 } })).toEqual({ w: 320, h: 240 });
  });
});

describe("placeImageShapes", () => {
  function deps(): ImageShapePlacementDeps & { added: unknown[] } {
    const added: unknown[] = [];
    return {
      added,
      persist: vi.fn(async (ref: CanvasImageRef) => ({
        uri: ref.kind === "path" ? `lotus-note-asset://from-${ref.path}` : `lotus-note-asset://from-${ref.name}`,
        alt: ref.kind === "path" ? "p" : ref.name,
      })),
      measure: vi.fn(async () => ({ width: 1600, height: 900 })),
      addShape: vi.fn((opts) => { added.push(opts); return `shape-${added.length}`; }),
    };
  }

  it("persists each image, sizes it via the clamp, and returns the created ids", async () => {
    const d = deps();
    const images: CanvasImageRef[] = [{ kind: "bytes", name: "a.png", mime: "image/png", base64: "AA" }];
    const ids = await placeImageShapes(images, { x: 100, y: 50 }, d, { max: 480 });

    expect(ids).toEqual(["shape-1"]);
    expect(d.persist).toHaveBeenCalledTimes(1);
    expect(d.added[0]).toMatchObject({
      assetUri: "lotus-note-asset://from-a.png",
      position: { x: 100, y: 50 },
      size: { w: 480, h: 270 },
      naturalWidth: 1600,
      naturalHeight: 900,
    });
  });

  it("cascades multiple images so they don't stack exactly on top of each other", async () => {
    const d = deps();
    const images: CanvasImageRef[] = [
      { kind: "bytes", name: "a.png", mime: "image/png", base64: "AA" },
      { kind: "bytes", name: "b.png", mime: "image/png", base64: "BB" },
    ];
    const ids = await placeImageShapes(images, { x: 0, y: 0 }, d, { max: 480 });

    expect(ids).toEqual(["shape-1", "shape-2"]);
    const first = d.added[0] as { position: { x: number; y: number } };
    const second = d.added[1] as { position: { x: number; y: number } };
    expect(second.position.x).toBeGreaterThan(first.position.x);
    expect(second.position.y).toBeGreaterThan(first.position.y);
  });

  it("skips an image whose bytes fail to persist, keeping the rest", async () => {
    const d = deps();
    (d.persist as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
    const images: CanvasImageRef[] = [
      { kind: "bytes", name: "a.png", mime: "image/png", base64: "AA" },
      { kind: "bytes", name: "b.png", mime: "image/png", base64: "BB" },
    ];
    const ids = await placeImageShapes(images, { x: 0, y: 0 }, d, { max: 480 });

    expect(ids).toEqual(["shape-1"]);
    expect(d.added).toHaveLength(1);
  });
});
