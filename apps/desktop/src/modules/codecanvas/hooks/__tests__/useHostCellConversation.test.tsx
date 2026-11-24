import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const hostConversationFor = vi.fn();
const hostDispatchFor = vi.fn();
const getActiveProjectLocation = vi.fn();

vi.mock("../../services/remote-host", () => ({
  hostConversationFor: (...a: unknown[]) => hostConversationFor(...a),
  hostDispatchFor: (...a: unknown[]) => hostDispatchFor(...a),
}));
vi.mock("../../services/canvas-active-project", () => ({
  getActiveProjectLocation: () => getActiveProjectLocation(),
}));

const { useHostCellConversation } = await import("../useHostCellConversation");
const { BUSY_POLL_MS } = await import("../../services/host-conversation");

const LOCATION = { kind: "ssh" as const, host: "devbox-vps", user: "alwi" };

function pageWith(text: string, closed = true) {
  return {
    ok: true, paneId: "ss-1", runner: "claude", source: "ring", hasMore: false,
    turns: [{
      turnId: "t1", startedAt: 1, ...(closed ? { endedAt: 2, stopReason: "end_turn" } : {}),
      parts: [{ id: "a", ts: 1, seq: 0, type: "assistant_text", text, state: "done", truncated: false }],
    }],
  };
}

describe("keeping one headless cell's conversation on screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveProjectLocation.mockReturnValue(LOCATION);
    hostConversationFor.mockResolvedValue(pageWith("hello"));
  });
  afterEach(() => vi.useRealTimers());

  /**
   * One poll is one ssh round trip. A node collapsed to a glyph is not being read by anyone, and
   * a board can hold a dozen of these — so invisible has to mean silent, not merely slower.
   */
  it("asks the host nothing while the node is not legible", async () => {
    renderHook(() => useHostCellConversation("ss-1", false));
    await Promise.resolve();
    expect(hostConversationFor).not.toHaveBeenCalled();
  });

  it("asks for the pane it was given, on the project's machine", async () => {
    const { result } = renderHook(() => useHostCellConversation("ss-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());
    expect(hostConversationFor).toHaveBeenCalledWith(LOCATION, "ss-1");
    expect(result.current.page?.turns[0].parts[0].raw.text).toBe("hello");
  });

  /**
   * It has to ask AGAIN, or the node is a screenshot. There is no push surface to fall back on:
   * `/m/stream` wants the pairing credential a phone holds, and `/v1` — the loopback surface
   * reached over the ssh connection the canvas already has — has none. A one-shot read would
   * leave a live agent's reply sitting on the host forever.
   */
  it("keeps asking on a timer, it does not read once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    hostConversationFor.mockResolvedValue(pageWith("working", false));
    renderHook(() => useHostCellConversation("ss-1", true));
    await waitFor(() => expect(hostConversationFor).toHaveBeenCalledTimes(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_POLL_MS + 50); });
    expect(hostConversationFor.mock.calls.length).toBeGreaterThan(1);
  });

  /**
   * A host restarting, a machine rebooting, one ssh hiccup: each of those is a reason to report
   * a problem, never a reason to blank a conversation somebody is reading. Clearing the page on
   * a failed poll would make a brief network blip indistinguishable from a cell with no history.
   */
  it("keeps the last good conversation when a poll fails", async () => {
    const { result } = renderHook(() => useHostCellConversation("ss-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    hostConversationFor.mockRejectedValue(new Error("ssh: connect timed out"));
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toContain("timed out"));

    expect(result.current.page?.turns[0].parts[0].raw.text).toBe("hello");
  });

  /** And the next good answer takes the warning away, rather than leaving it stuck on screen. */
  it("clears the warning once the host answers again", async () => {
    hostConversationFor.mockRejectedValueOnce(new Error("ssh: connect timed out"));
    const { result } = renderHook(() => useHostCellConversation("ss-1", true));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    hostConversationFor.mockResolvedValue(pageWith("back"));
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  /**
   * A reachable host answering something unreadable is not the same as an unreachable one, and
   * neither is the same as a cell with no history — but all three look identical if the node just
   * keeps saying "Reading the conversation…". This is the one of the three that has no other tell.
   */
  it("says so when the host answers something that is not a conversation", async () => {
    hostConversationFor.mockResolvedValue({ ok: false, error: "that cell has a terminal" });
    const { result } = renderHook(() => useHostCellConversation("ss-1", true));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.page).toBeNull();
  });

  /**
   * Dispatch is the half of this node that changes something on another machine. A failure has to
   * reach the operator who typed it — the ticket-11 measurement that made this its own concern is
   * that the host answers `ok:false` inside an HTTP 200, so "it was sent" and "it landed" are two
   * different facts.
   */
  it("reports a prompt that did not land", async () => {
    const { result } = renderHook(() => useHostCellConversation("ss-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    hostDispatchFor.mockRejectedValue(new Error("no live session for paneId"));
    await act(async () => { await result.current.send("status?"); });

    expect(result.current.error).toContain("no live session");
  });

  /** Whitespace is not a prompt, and sending one would open an empty turn on someone's agent. */
  it("does not send an empty prompt", async () => {
    const { result } = renderHook(() => useHostCellConversation("ss-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());
    await act(async () => { await result.current.send("   "); });
    expect(hostDispatchFor).not.toHaveBeenCalled();
  });

  /**
   * A node outliving its project — the board closed, the location gone — must go quiet rather
   * than throw on a timer nobody can see.
   */
  it("goes quiet when the board is no longer open on a machine", async () => {
    getActiveProjectLocation.mockReturnValue(null);
    const { result } = renderHook(() => useHostCellConversation("ss-1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(hostConversationFor).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});
