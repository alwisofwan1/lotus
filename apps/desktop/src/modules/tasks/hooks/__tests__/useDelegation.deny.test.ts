import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DENY_NEEDS_CLAUDE, useDelegation } from "@/modules/tasks/hooks/useDelegation";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";

const task = { id: "t1", workspaceId: "w1", title: "TKT-1008", goal: "g", knowledge: "" } as unknown as BridgeTask;

describe("delegating with tools denied", () => {
  it("refuses a preset that cannot be kept from them, instead of delegating without them", async () => {
    const addPane = vi.fn(() => null);
    const { result } = renderHook(() => useDelegation("w1", addPane as never, vi.fn(async () => undefined)));

    const message = await result.current.delegate(
      task,
      { id: "c", name: "Codex", agent: "codex", args: "", instructions: "" },
      "TKT-1008",
      { denyTools: ["mcp__*__notion-update-page"] },
    );

    expect(message).toBe(DENY_NEEDS_CLAUDE);
    expect(addPane).not.toHaveBeenCalled();
  });
});

describe("delegating into a folder inside the workspace", () => {
  it("opens the pane in that folder (a GitHub issue's checkout)", async () => {
    const addPane = vi.fn(() => null);
    const { result } = renderHook(() => useDelegation("w1", addPane as never, vi.fn(async () => undefined)));

    await result.current.delegate(task, { id: "c", name: "Claude", agent: "claude", args: "", instructions: "" }, "#18", {
      cwd: "/clients/flow-trader",
    });

    expect(addPane).toHaveBeenCalledWith("w1", expect.stringMatching(/^claude/), "/clients/flow-trader", expect.objectContaining({ id: "t1" }), undefined);
  });
});

describe("delegating with a Claude preset on an account (issues/07)", () => {
  it("opens the pane on the preset's account", async () => {
    const addPane = vi.fn(() => null);
    const { result } = renderHook(() => useDelegation("w1", addPane as never, vi.fn(async () => undefined)));

    await result.current.delegate(task, { id: "c", name: "HSS", agent: "claude", args: "", instructions: "", account: "hss" }, "#18");

    expect(addPane).toHaveBeenCalledWith("w1", expect.stringMatching(/^claude/), undefined, expect.objectContaining({ id: "t1" }), "hss");
  });
});
