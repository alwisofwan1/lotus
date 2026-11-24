import { describe, expect, it, vi } from "vitest";
import { augmentAnnotationPayloadWithScreenshot } from "../canvas-browser-annotation-screenshot-merge";

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "selected",
    id: "annotation-1",
    boundingBox: { x: 653, y: 136, width: 373, height: 210 },
    viewport: { width: 1438, height: 785, scrollX: 0, scrollY: 0 },
    ...overrides,
  });
}

describe("canvas-browser-annotation-screenshot-merge", () => {
  it("captures a screenshot with the computed crop rect and merges its path into the payload as a visual attachment", async () => {
    const capture = vi.fn().mockResolvedValue("/tmp/shot.png");

    const augmented = await augmentAnnotationPayloadWithScreenshot(payload(), "browser-1", capture);

    expect(capture).toHaveBeenCalledWith("browser-1", expect.objectContaining({
      width: expect.closeTo(373, 1),
    }));
    const parsed = JSON.parse(augmented);
    expect(parsed.id).toBe("annotation-1");
    expect(parsed.visualAttachments).toEqual([
      { name: "selected-region.png", path: "/tmp/shot.png", mimeType: "image/png" },
    ]);
  });

  it("returns the original payload unchanged when the capture fails (best-effort)", async () => {
    const capture = vi.fn().mockRejectedValue(new Error("node parked"));
    const original = payload();

    const augmented = await augmentAnnotationPayloadWithScreenshot(original, "browser-1", capture);

    expect(augmented).toBe(original);
  });

  it("returns the original payload unchanged for malformed JSON, without attempting a capture", async () => {
    const capture = vi.fn();

    const augmented = await augmentAnnotationPayloadWithScreenshot("not json", "browser-1", capture);

    expect(augmented).toBe("not json");
    expect(capture).not.toHaveBeenCalled();
  });
});
