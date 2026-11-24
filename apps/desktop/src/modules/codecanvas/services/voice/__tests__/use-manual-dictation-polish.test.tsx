import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useManualDictationPolish } from "../use-manual-dictation-polish";

function setup() {
  let finish!: (text: string) => void;
  const build = vi.fn((_text: string, _polish: boolean, _signal?: AbortSignal) =>
    new Promise<string>((resolve) => { finish = resolve; }));
  const setText = vi.fn();
  const hook = renderHook(({ text, blocked }) => useManualDictationPolish({ text, blocked, build, setText }), {
    initialProps: { text: "original draft", blocked: false },
  });
  return { ...hook, build, setText, finish: (text: string) => finish(text) };
}

describe("manual dictation polish", () => {
  it("only polishes on request and keeps the draft available while waiting", async () => {
    const h = setup();
    expect(h.build).not.toHaveBeenCalled();
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.polish(); });
    expect(h.result.current.polishing).toBe(true);
    expect(h.setText).not.toHaveBeenCalled();
    await act(async () => { h.finish("clean draft"); await pending; });
    expect(h.setText).toHaveBeenCalledWith("clean draft");
  });
  it("keeps the draft when the cleanup adapter fails", async () => {
    const setText = vi.fn();
    const { result } = renderHook(() => useManualDictationPolish({
      text: "original draft", blocked: false, setText,
      build: async () => { throw new Error("adapter failed"); },
    }));
    await act(async () => { await expect(result.current.polish()).resolves.toBeUndefined(); });
    expect(setText).not.toHaveBeenCalled();
    expect(result.current.polishing).toBe(false);
  });
  it.each(["edit", "send", "unmount"])("cancels on %s and never replaces newer text", async (cause) => {
    const h = setup();
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.polish(); });
    const signal = h.build.mock.calls[0][2];
    if (cause === "edit") h.rerender({ text: "new draft", blocked: false });
    if (cause === "send") act(() => h.result.current.cancel());
    if (cause === "unmount") h.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { h.finish("late polish"); await pending; });
    expect(h.setText).not.toHaveBeenCalled();
  });
});
