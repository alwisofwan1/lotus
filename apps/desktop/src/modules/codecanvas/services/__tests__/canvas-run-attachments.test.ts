import { describe, expect, it } from "vitest";
import { splitImageRefs } from "../canvas-run-attachments";
import type { CanvasImageRef } from "../canvas-intake";

describe("splitImageRefs", () => {
  it("routes path refs to paths and byte refs to base64 data-URL attachments", () => {
    const refs: CanvasImageRef[] = [
      { kind: "path", path: "/Users/a/shot.png" },
      { kind: "bytes", name: "paste.png", mime: "image/png", base64: "QUJD" },
    ];
    expect(splitImageRefs(refs)).toEqual({
      paths: ["/Users/a/shot.png"],
      attachments: [{ name: "paste.png", content: "data:image/png;base64,QUJD", mimeType: "image/png" }],
    });
  });

  it("returns empty transports for no refs", () => {
    expect(splitImageRefs([])).toEqual({ attachments: [], paths: [] });
  });
});
