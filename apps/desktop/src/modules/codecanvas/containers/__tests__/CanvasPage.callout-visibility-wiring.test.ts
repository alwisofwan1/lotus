import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wiring guard for the callout visibility policy (agent-done notify RCA): CanvasPage must classify
 * a node as "visible" only when the app window is focused and unhidden, not from the node rect
 * alone — otherwise a blurred/minimized window silences exactly the background finishes the
 * callouts exist for. The policy itself is covered by the computeAnnounceVisibility unit tests;
 * this pins the container wiring (no cheap render harness for ReactFlow + window focus).
 */
const source = readFileSync(join(__dirname, "..", "CanvasPage.tsx"), "utf8");

describe("CanvasPage callout visibility wiring", () => {
  it("routes the rect check through computeAnnounceVisibility with real window focus state", () => {
    expect(source).toContain("computeAnnounceVisibility(");
    expect(source).toContain("document.hasFocus()");
    expect(source).toContain("document.hidden");
  });
});
