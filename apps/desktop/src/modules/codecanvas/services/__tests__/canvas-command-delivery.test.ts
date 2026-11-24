import { describe, expect, it } from "vitest";
import { createCanvasCommandDeliveryEvents } from "../canvas-command-delivery";

describe("createCanvasCommandDeliveryEvents", () => {
  it("emits cues for delivered and queued agents, but not skipped agents", () => {
    const events = createCanvasCommandDeliveryEvents({
      source: "nl-command",
      targetNodeId: "__all__",
      text: "fix lint errors",
      result: {
        delivered: ["agent-1"],
        queued: ["agent-2"],
        skipped: ["agent-3"],
      },
      now: () => 12,
      idFactory: () => "delivery-id",
    });

    expect(events).toEqual([
      expect.objectContaining({ targetNodeId: "agent-1", outcome: "delivered", commandPreview: "fix lint errors", createdAt: 12 }),
      expect.objectContaining({ targetNodeId: "agent-2", outcome: "queued", commandPreview: "fix lint errors", createdAt: 12 }),
    ]);
  });

  it("compacts multiline command previews", () => {
    const events = createCanvasCommandDeliveryEvents({
      source: "nl-command",
      targetNodeId: "agent-1",
      text: `please fix lint errors\n\n${"and tighten tests ".repeat(12)}`,
      result: {
        delivered: ["agent-1"],
        queued: [],
        skipped: [],
      },
      now: () => 12,
      idFactory: () => "delivery-id",
    });

    expect(events[0]?.commandPreview).toMatch(/^please fix lint errors and tighten tests/);
    expect(events[0]?.commandPreview.length).toBeLessThanOrEqual(96);
  });
});
