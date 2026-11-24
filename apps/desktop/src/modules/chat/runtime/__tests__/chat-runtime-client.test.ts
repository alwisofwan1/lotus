import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
class FakeChannel {
  onmessage: (message: unknown) => void = () => {};
}
vi.mock("@/lib/tauri/runtime", () => ({ loadTauriCore: async () => ({ invoke, Channel: FakeChannel }) }));
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => unlisten }));

import { onChatRailChange, sendChatMessage, subscribeChatThread } from "../chat-runtime-client";

const turnStarted = (seq: number) => ({
  threadId: "t",
  seq,
  at: 1,
  event: { type: "turn/started", turnId: `u${seq}`, input: null },
});

describe("chat runtime client", () => {
  beforeEach(() => invoke.mockReset());

  it("subscribes from a seq, delivers valid envelopes and skips invalid ones", async () => {
    let channel: FakeChannel | null = null;
    invoke.mockImplementation(async (command: string, args: { onEvent?: FakeChannel }) => {
      if (command === "chat_subscribe") channel = args.onEvent ?? null;
      return { subscriptionId: 7, replayedThrough: 4 };
    });
    const seen: number[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unsubscribe = await subscribeChatThread({ threadId: "t", afterSeq: 4, onEvent: (e) => seen.push(e.seq) });

    expect(invoke).toHaveBeenCalledWith("chat_subscribe", expect.objectContaining({ threadId: "t", afterSeq: 4 }));
    channel!.onmessage(turnStarted(5));
    channel!.onmessage({ threadId: "t", seq: 6, at: 1, event: { type: "from/the-future" } });
    channel!.onmessage(turnStarted(7));
    expect(seen).toEqual([5, 7]);
    expect(warn).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    channel!.onmessage(turnStarted(8));
    expect(seen).toEqual([5, 7]);
    expect(invoke.mock.calls.filter(([c]) => c === "chat_unsubscribe")).toEqual([["chat_unsubscribe", { subscriptionId: 7 }]]);
    warn.mockRestore();
  });

  it("says the replay arrived only once the channel delivered the runtime's last replayed seq", async () => {
    let channel: FakeChannel | null = null;
    let reply: (value: unknown) => void = () => {};
    invoke.mockImplementation((command: string, args: { onEvent?: FakeChannel }) => {
      if (command !== "chat_subscribe") return Promise.resolve();
      channel = args.onEvent ?? null;
      return new Promise((resolve) => (reply = resolve));
    });
    const onReplayed = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const subscribed = subscribeChatThread({ threadId: "t", afterSeq: 0, onEvent: () => {}, onReplayed });
    await vi.waitFor(() => expect(channel).not.toBeNull());

    // The reply can land before the history: the first event is not the end of it.
    channel!.onmessage(turnStarted(1));
    reply({ subscriptionId: 1, replayedThrough: 3 });
    await subscribed;
    expect(onReplayed).not.toHaveBeenCalled();
    channel!.onmessage(turnStarted(2));
    expect(onReplayed).not.toHaveBeenCalled();
    // The last one is an event this build skips; it still ends the replay.
    channel!.onmessage({ threadId: "t", seq: 3, at: 1, event: { type: "from/the-future" } });
    expect(onReplayed).toHaveBeenCalledTimes(1);
    channel!.onmessage(turnStarted(4));
    expect(onReplayed).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("says the replay arrived at once when there was nothing to replay", async () => {
    invoke.mockResolvedValue({ subscriptionId: 1, replayedThrough: 5 });
    const onReplayed = vi.fn();
    await subscribeChatThread({ threadId: "t", afterSeq: 5, onEvent: () => {}, onReplayed });
    expect(onReplayed).toHaveBeenCalledTimes(1);
  });

  it("sends with a request id", async () => {
    invoke.mockResolvedValue(undefined);
    await sendChatMessage("t", "hi");
    expect(invoke).toHaveBeenCalledWith("chat_send", { threadId: "t", text: "hi", clientRequestId: expect.any(String), attachments: [] });
  });

  it("unlistens the rail once, also when stopped before listen resolves", async () => {
    unlisten.mockReset();
    const stop = onChatRailChange(() => {});
    stop();
    stop();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
