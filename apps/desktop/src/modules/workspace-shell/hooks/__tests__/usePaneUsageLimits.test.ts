import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePaneUsageLimits } from "../usePaneUsageLimits";

describe("usePaneUsageLimits", () => {
  it("marks a pane whose turn hit a limit, and unmarks it on a normal turn end or a move", () => {
    let fire: (paneId: string, sessionId?: string | null, limit?: string | null) => void = () => {};
    const subscribe = (cb: typeof fire) => {
      fire = cb;
      return () => {};
    };
    const { result } = renderHook(() => usePaneUsageLimits(subscribe));

    act(() => fire("p1", "s", "You've hit your 5-hour limit · resets 2:20pm"));
    expect(result.current.limits.get("p1")).toBe("You've hit your 5-hour limit · resets 2:20pm");
    act(() => fire("p1", "s", null));
    expect(result.current.limits.has("p1")).toBe(false);

    act(() => fire("p2", "s", "limit"));
    act(() => result.current.clear("p2"));
    expect(result.current.limits.size).toBe(0);
  });
});
