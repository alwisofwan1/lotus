import { afterEach, describe, expect, it, vi } from "vitest";

import "../claude-session";

describe("claude-session warning filter", () => {
  const onWarning = vi.fn();
  afterEach(() => {
    process.off("warning", onWarning);
    onWarning.mockReset();
  });

  it("mutes only the SDK's canUseTool-shadowed warning", async () => {
    process.on("warning", onWarning);
    process.emitWarning("shadowed", { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" });
    process.emitWarning("other", { code: "SOMETHING_ELSE" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onWarning.mock.calls.map(([w]) => (w as Error).message)).toEqual(["other"]);
  });
});
