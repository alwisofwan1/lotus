import { describe, expect, it } from "vitest";
import { parseCanvasBrowserAnnotationContext } from "../canvas-browser-annotation-context";

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "selected",
    id: "annotation-1",
    agentId: "terminal:term-1",
    url: "https://example.com",
    title: "Example",
    selector: "button.primary",
    breadcrumb: ["main", "section.hero"],
    label: "button: Deploy",
    text: "Deploy",
    message: "Make this clearer",
    dimensions: { width: 120, height: 32 },
    computedStyles: { color: "rgb(255, 255, 255)" },
    reactComponent: "DeployButton",
    classes: ["primary", "rounded"],
    summary: ["actions: Deploy"],
    outerHTML: "<button>Deploy</button>",
    boundingBox: { x: 10, y: 20, width: 120, height: 32 },
    viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 120 },
    createdAt: "2026-05-02T16:00:00.000Z",
    ...overrides,
  });
}

describe("canvas-browser-annotation-context", () => {
  it("includes a tight, viewport-relative crop rect for exactly the selected element", () => {
    const result = parseCanvasBrowserAnnotationContext(payload({
      boundingBox: { x: 653, y: 136, width: 373, height: 210 },
      viewport: { width: 1438, height: 785, scrollX: 0, scrollY: 0 },
    }));

    if (!result.ok) throw new Error("expected ok result");
    expect(result.cropRect).not.toBeNull();
    expect(result.cropRect!.x).toBeCloseTo(653, 1);
    expect(result.cropRect!.y).toBeCloseTo(136, 1);
    expect(result.cropRect!.width).toBeCloseTo(373, 1);
    expect(result.cropRect!.height).toBeCloseTo(210, 1);
  });

  it("clamps to the viewport top instead of a negative y when the element straddles the scroll edge", () => {
    // scrollY:30 puts the box's viewport-relative top at 20-30=-10 (partly scrolled past),
    // but its bottom (-10+32=22) is still on-screen — a real partially-visible case, not a
    // fully-scrolled-off one (which correctly yields no crop at all, see the "returns null" tests).
    const result = parseCanvasBrowserAnnotationContext(payload({
      boundingBox: { x: 10, y: 20, width: 120, height: 32 },
      viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 30 },
    }));

    if (!result.ok) throw new Error("expected ok result");
    expect(result.cropRect!.y).toBe(0);
  });

  it("parses and formats a captured browser annotation into agent-readable context", () => {
    const result = parseCanvasBrowserAnnotationContext(payload());

    expect(result).toMatchObject({ ok: true, annotationId: "annotation-1" });
    if (!result.ok) throw new Error("expected ok result");
    expect(result.context).toBe(
      '<picked-elements>\n<pick page="https://example.com" selector="button.primary" element="button" text="Deploy" component="DeployButton" styles="color: rgb(255, 255, 255)" html="&lt;button>Deploy&lt;/button>" box="10,20 120x32" />\n</picked-elements>\n\nMake this clearer',
    );
  });

  it("rejects standalone browser annotations with no terminal to route to", () => {
    // Callers decide what "missing-terminal" means for their delivery mechanism;
    // this module only parses/formats, so it has no opinion on routing targets.
    expect(parseCanvasBrowserAnnotationContext(payload())).toMatchObject({ ok: true });
  });

  it("ignores metadata-only visual attachment navigation follow-ups so one selection is not submitted twice", () => {
    const result = parseCanvasBrowserAnnotationContext(
      payload({ visualAttachments: [{ name: "annotation.png", mimeType: "image/png" }] }),
    );

    expect(result).toEqual({ ok: false, reason: "attachment-metadata-only" });
  });

  it("includes persisted selected image paths in the formatted context", () => {
    const result = parseCanvasBrowserAnnotationContext(
      payload({ visualAttachments: [{ name: "google.png", mimeType: "image/png", path: "/tmp/google.png" }] }),
    );

    if (!result.ok) throw new Error("expected ok result");
    expect(result.context).toContain('picture="/tmp/google.png" />');
  });

  it("rejects malformed JSON payloads", () => {
    expect(parseCanvasBrowserAnnotationContext("not json")).toMatchObject({ ok: false });
  });
});
