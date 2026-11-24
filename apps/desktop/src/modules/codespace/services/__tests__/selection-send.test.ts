import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_AGENT_SURFACE_REASON,
  onSelectionSend,
  sendSelectionToAgent,
} from "@/modules/codespace/services/selection-send";

describe("sendSelectionToAgent", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("says so when no surface is listening", () => {
    expect(sendSelectionToAgent("ed-1", "x")).toEqual({ ok: false, reason: NO_AGENT_SURFACE_REASON });
  });

  it("asks each surface in turn; the one that owns the pane answers", () => {
    const canvas = vi.fn(() => null);
    const code = vi.fn(() => ({ ok: true as const }));
    cleanups.push(onSelectionSend(canvas), onSelectionSend(code));

    expect(sendSelectionToAgent("ed-1", "src/x.ts:1")).toEqual({ ok: true });
    expect(canvas).toHaveBeenCalledWith("ed-1", "src/x.ts:1");
    expect(code).toHaveBeenCalledWith("ed-1", "src/x.ts:1");
  });

  it("does not bother a surface with an empty selection", () => {
    const code = vi.fn(() => ({ ok: true as const }));
    cleanups.push(onSelectionSend(code));
    expect(sendSelectionToAgent("ed-1", "  \n")).toEqual({ ok: false, reason: "Nothing is selected." });
    expect(code).not.toHaveBeenCalled();
  });

  it("stops asking a surface once it unregisters", () => {
    const code = vi.fn(() => ({ ok: true as const }));
    onSelectionSend(code)();
    expect(sendSelectionToAgent("ed-1", "x").ok).toBe(false);
  });
});
