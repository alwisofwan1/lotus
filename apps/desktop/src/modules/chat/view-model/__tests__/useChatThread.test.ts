import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadEventEnvelope } from "../../domain/thread-event";

interface Subscription {
  threadId: string;
  afterSeq: number;
  onEvent: (e: ThreadEventEnvelope) => void;
  onReplayed?: () => void;
}
let current: Subscription | null = null;
const stop = vi.fn();
vi.mock("../../runtime/chat-runtime-client", () => ({
  subscribeChatThread: async (subscription: Subscription) => {
    current = subscription;
    return stop;
  },
}));

import { useChatThread } from "../useChatThread";

const deliver = (envelope: ThreadEventEnvelope) => current!.onEvent(envelope);
const started = (threadId: string, seq: number): ThreadEventEnvelope => ({
  threadId,
  seq,
  at: seq,
  event: { type: "turn/started", turnId: `u${seq}`, input: null },
});
const message = (threadId: string, seq: number, status: "running" | "completed", text: string): ThreadEventEnvelope => ({
  threadId,
  seq,
  at: seq,
  event: { type: status === "running" ? "item/started" : "item/completed", turnId: "u1", item: { id: "a", kind: "agentMessage", status, text } },
});
const delta = (threadId: string, seq: number, text: string): ThreadEventEnvelope => ({
  threadId,
  seq,
  at: seq,
  event: { type: "item/delta", turnId: "u1", itemId: "a", delta: text },
});

describe("useChatThread", () => {
  it("folds a burst of live events into one update, then unsubscribes on unmount", async () => {
    const { result, unmount } = renderHook(() => useChatThread("burst"));
    await waitFor(() => expect(current?.threadId).toBe("burst"));
    act(() => current!.onReplayed!());
    const renders: number[] = [];
    act(() => {
      deliver(started("burst", 1));
      deliver(message("burst", 2, "running", ""));
      deliver(delta("burst", 3, "Hel"));
      deliver(delta("burst", 4, "lo"));
      renders.push(result.current.state?.lastSeq ?? -1);
    });
    await waitFor(() => expect(result.current.state?.lastSeq).toBe(4));
    expect(renders).toEqual([0]); // nothing new drawn until the frame folds the burst
    expect(result.current.rows).toMatchObject([{ kind: "assistant", text: "Hello", streaming: true }]);
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("draws the stored history whole once it has arrived, never a partly replayed thread", async () => {
    const { result } = renderHook(() => useChatThread("history"));
    await waitFor(() => expect(current?.threadId).toBe("history"));
    // Replayed over several frames: the reply would look live ("running") midway.
    act(() => {
      deliver(started("history", 1));
      deliver(message("history", 2, "running", "Hel"));
    });
    await act(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(result.current.state).toBeNull();
    act(() => {
      deliver(message("history", 3, "completed", "Hello"));
      current!.onReplayed!();
    });
    expect(result.current.state?.lastSeq).toBe(3);
    expect(result.current.rows).toMatchObject([{ kind: "assistant", text: "Hello", streaming: false }]);
  });

  it("shows a thread seen before at once and replays only what it missed", async () => {
    const { result, rerender } = renderHook(({ id }) => useChatThread(id), { initialProps: { id: "back" } });
    await waitFor(() => expect(current?.threadId).toBe("back"));
    act(() => {
      deliver(started("back", 1));
      deliver(message("back", 2, "completed", "Kept"));
      current!.onReplayed!();
    });

    rerender({ id: "other" });
    await waitFor(() => expect(current?.threadId).toBe("other"));
    act(() => current!.onReplayed!());
    expect(result.current.state?.threadId).toBe("other");
    rerender({ id: "back" });
    // The first render after the switch already has it: no empty frame, no replay from 0.
    expect(result.current.state?.lastSeq).toBe(2);
    expect(result.current.rows).toMatchObject([{ kind: "assistant", text: "Kept" }]);
    await waitFor(() => expect(current?.threadId).toBe("back"));
    expect(current!.afterSeq).toBe(2);
  });
});
