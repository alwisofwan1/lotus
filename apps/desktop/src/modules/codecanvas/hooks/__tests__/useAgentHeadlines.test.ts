import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAgentHeadlines } from "../useAgentHeadlines";
import { createAgentHeadlineStore } from "../../services/agent-headline-store";

describe("useAgentHeadlines", () => {
  it("reads the headline for any pane the caller asks about", () => {
    // A reader FUNCTION rather than one value: the sidebar and the lane both render N rows, and a
    // hook per row is not allowed. One subscription, many synchronous reads.
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "editing · auth", key: "editing|auth" });
    store.record("p-2", { text: "searching", key: "searching|" });

    const { result } = renderHook(() => useAgentHeadlines(store));

    expect(result.current("p-1")).toBe("editing · auth");
    expect(result.current("p-2")).toBe("searching");
    expect(result.current("p-3")).toBeUndefined();
  });

  it("re-renders when a headline changes", () => {
    const store = createAgentHeadlineStore();
    const { result } = renderHook(() => useAgentHeadlines(store));

    act(() => store.record("p-1", { text: "editing", key: "editing|" }));

    expect(result.current("p-1")).toBe("editing");
  });

  it("does not re-render for a change the store absorbed", () => {
    // The stability rule has to reach all the way to the render: a tense flip that the store held
    // must not repaint a sidebar of eight rows.
    const store = createAgentHeadlineStore();
    store.record("p-1", { text: "running a command", key: "running a command|" });
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useAgentHeadlines(store);
    });
    const before = renders;

    act(() => store.record("p-1", { text: "ran a command", key: "running a command|" }));

    expect(renders).toBe(before);
  });

  it("stops listening on unmount", () => {
    const store = createAgentHeadlineStore();
    const { unmount } = renderHook(() => useAgentHeadlines(store));

    unmount();

    expect(() => store.record("p-1", { text: "editing", key: "editing|" })).not.toThrow();
  });
});
