import { beforeEach, describe, expect, it, vi } from "vitest";

const activateWebglRenderer = vi.fn();

vi.mock("@/modules/codespace/services/terminal-addons", () => ({
  activateWebglRenderer: (...args: unknown[]) => activateWebglRenderer(...args),
}));

import { activatePooledWebglRenderer } from "../terminal-v2-pooled-renderer-acceleration";
import type { TerminalV2PooledXtermLike } from "../terminal-v2-pooled-xterm-renderer-factory";

const terminal = {} as TerminalV2PooledXtermLike;

describe("activatePooledWebglRenderer", () => {
  beforeEach(() => {
    activateWebglRenderer.mockReset();
    activateWebglRenderer.mockResolvedValue(null);
  });

  it("asks the shared webgl policy rather than deciding for itself", async () => {
    // The policy is where the Tauri/backoff/software-renderer rules live. Naming the surface is
    // what tells it this is the pooled slot — the one whose lifecycle was verified — rather than
    // the legacy pane path that stays on the DOM renderer.
    const onLost = vi.fn();
    const isStale = vi.fn(() => false);

    await activatePooledWebglRenderer(terminal, { isStale, onLost });

    expect(activateWebglRenderer).toHaveBeenCalledWith(terminal, expect.objectContaining({
      activePaneEligible: true,
      surface: "codespace-pooled",
      isStale,
      onLost,
    }));
  });

  it("reports the policy's refusal as no acceleration, not as an error", async () => {
    await expect(activatePooledWebglRenderer(terminal, { isStale: () => false, onLost: () => {} }))
      .resolves.toBeNull();
  });
});
