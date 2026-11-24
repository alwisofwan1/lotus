import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { deliverCanvasTerminalText } from "../canvas-terminal-delivery";

const terminal: Node = {
  id: "terminal-1",
  type: "terminal",
  position: { x: 0, y: 0 },
  data: { terminalNumber: 1, label: "API server", runtimePaneId: "canvas:project:terminal-1" },
};

afterEach(() => vi.useRealTimers());

describe("deliverCanvasTerminalText", () => {
  it("reports delivery using the terminal's custom name", async () => {
    await expect(deliverCanvasTerminalText("terminal-1", "git status", [terminal], {
      getStatus: () => "live",
      writeConfirmed: async () => {},
    })).resolves.toMatchObject({ ok: true, nodeName: "API server" });
  });

  it("reports an unknown write state on timeout instead of encouraging a duplicate retry", async () => {
    vi.useFakeTimers();
    const delivery = deliverCanvasTerminalText("terminal-1", "git status", [terminal], {
      getStatus: () => "live",
      writeConfirmed: () => new Promise<void>(() => {}),
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);

    await expect(delivery).resolves.toMatchObject({
      ok: false,
      reason: "delivery-unknown",
      message: expect.stringMatching(/status is unknown.*check the terminal before retrying/i),
    });
  });
});
