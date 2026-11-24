import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { NARRATION_TICK_MS, useNarrationChannel } from "../use-narration-channel";
import type { AgentHookDropPayload } from "../narration-event";

const NOW = 1_700_000_000_000;

const drop = (over: Partial<AgentHookDropPayload> = {}): AgentHookDropPayload => ({
  version: 1,
  sessionId: "s1",
  agentType: "claude",
  event: "tool-pre",
  status: "running",
  title: "Edit",
  body: "src/auth.ts",
  userPrompt: "",
  cwd: "/repo",
  pid: null,
  agentPid: null,
  paneId: "canvas:projA:node-9",
  timestamp: NOW,
  ...over,
});

/** Let the compose promise chain settle. Two microtasks is not enough — the composer awaits a
 *  timeout-wrapped call, so the resolution lands a macrotask later. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Injectable transport, mirroring `useAgentDoneCallouts`' subscriber so no Tauri mock is needed. */
function makeHookSource() {
  let cb: ((p: AgentHookDropPayload) => void) | undefined;
  return {
    subscribe: (fn: (p: AgentHookDropPayload) => void) => {
      cb = fn;
      return () => {
        cb = undefined;
      };
    },
    fire: (p: AgentHookDropPayload) => cb?.(p),
  };
}

function setup(over: { enabled?: boolean; liveVoiceActive?: boolean } = {}) {
  const source = makeHookSource();
  const announce = vi.fn();
  const focusNode = vi.fn();
  const complete = vi.fn(async () => "Refactored the auth flow — suite is green.");
  const clock = { t: NOW };
  const { unmount, rerender: rerenderHook } = renderHook(
    (props: { liveVoiceActive: boolean }) =>
    useNarrationChannel({
      enabled: over.enabled ?? true,
      liveVoiceActive: props.liveVoiceActive,
      subscribeAgentHook: source.subscribe,
      announce,
      focusNode,
      complete,
      resolveName: (paneId) => paneId.split(":").pop() ?? paneId,
      now: () => clock.t,
    }),
    { initialProps: { liveVoiceActive: over.liveVoiceActive ?? false } },
  );
  const rerender = (props: { liveVoiceActive: boolean }) => rerenderHook(props);
  return { source, announce, focusNode, complete, clock, unmount, rerender };
}

describe("useNarrationChannel", () => {
  it("says what the agent is doing, never the raw file path", async () => {
    // This assertion used to demand the path verbatim — it encoded the bug. `neutral` is source
    // material; speaking it is what made narration sound like a screen reader.
    vi.useFakeTimers();
    try {
      const { source, announce } = setup();
      source.fire(drop());
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 2);

      expect(announce).toHaveBeenCalledWith("editing auth", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("summarises a turn end instead of reciting the agent's whole reply", async () => {
    vi.useFakeTimers();
    try {
      const { source, announce, complete } = setup();
      source.fire(drop({ event: "stop", title: "", body: "I refactored the auth flow. ".repeat(40) }));
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 2);

      expect(complete).toHaveBeenCalled();
      expect(announce).toHaveBeenCalledWith("Refactored the auth flow — suite is green.", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pay a model round-trip for routine tool work", async () => {
    const { source, complete } = setup();
    source.fire(drop());
    await settle();

    expect(complete).not.toHaveBeenCalled();
  });

  it("stays completely silent when the setting is off", () => {
    // Default-off is the whole safety story for this slice: nobody gets narrated at until they
    // ask for it.
    const { source, announce, focusNode } = setup({ enabled: false });
    source.fire(drop());

    expect(announce).not.toHaveBeenCalled();
    expect(focusNode).not.toHaveBeenCalled();
  });

  it("ignores hook events that are not narration — the drop stream carries every hook", () => {
    const { source, announce } = setup();
    source.fire(drop({ event: "session-start" }));
    source.fire(drop({ event: "notification" }));

    expect(announce).not.toHaveBeenCalled();
  });

  it("ignores a stale event replayed by the startup drain", () => {
    // The Rust drainer re-emits anything under five minutes old. Narrating it in the present tense
    // would describe work that finished before the app opened.
    const { source, announce } = setup();
    source.fire(drop({ timestamp: NOW - 4 * 60_000 }));

    expect(announce).not.toHaveBeenCalled();
  });

  it("points the camera at an agent that failed", () => {
    const { source, focusNode } = setup();
    source.fire(drop({ event: "tool-post-failed", body: "exit 1" }));

    expect(focusNode).toHaveBeenCalledWith("node-9");
  });

  it("leaves the camera alone for routine work", () => {
    const { source, focusNode } = setup();
    source.fire(drop());

    expect(focusNode).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount so a remount does not double-narrate", () => {
    const { source, announce, unmount } = setup();
    unmount();
    source.fire(drop());

    expect(announce).not.toHaveBeenCalled();
  });
});

describe("useNarrationChannel — pacing", () => {
  it("does not fire a synthesis per tool call", async () => {
    // The hang: announce() speaks immediately and cloud TTS is latest-wins, so a busy agent meant
    // one aborted network round-trip per event. A burst must cost ONE utterance.
    vi.useFakeTimers();
    try {
      const { source, announce } = setup();
      for (let i = 0; i < 6; i += 1) source.fire(drop({ title: "Edit", body: `/r/a/file${i}.ts` }));
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 2);

      expect(announce.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says what a burst WAS, not a list of what it did", async () => {
    // This used to assert both raw phrases survived into the spoken line — a list of mechanics.
    // A burst is now composed into one intent sentence; the steps are the input, not the output.
    vi.useFakeTimers();
    try {
      const { source, announce, complete } = setup();
      source.fire(drop({ title: "Edit", body: "/r/a/auth.ts" }));
      source.fire(drop({ title: "Bash", body: "" }));
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 3);

      expect(complete).toHaveBeenCalled();
      expect(announce).toHaveBeenCalledWith("Refactored the auth flow — suite is green.", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops ticking on unmount", async () => {
    vi.useFakeTimers();
    try {
      const { source, announce, unmount } = setup();
      source.fire(drop());
      unmount();
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 3);

      expect(announce).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useNarrationChannel — verbosity", () => {
  it("does not announce a tool that merely succeeded", async () => {
    vi.useFakeTimers();
    try {
      const { source, announce } = setup();
      source.fire(drop({ event: "tool-post", title: "Edit", body: "/r/a/auth.ts" }));
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 2);

      expect(announce).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still announces a failure", async () => {
    vi.useFakeTimers();
    try {
      const { source, announce } = setup();
      source.fire(drop({ event: "tool-post-failed", title: "Bash", body: "exit 1" }));
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 2);

      expect(announce).toHaveBeenCalledWith("that command failed", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useNarrationChannel — the digest actually gets spoken", () => {
  it("drains deferred work instead of losing it silently", async () => {
    // `collectFlushes` had no production caller: with two agents running, routine work entered the
    // digest queue and never came out. Silent data loss, invisible with a single agent.
    vi.useFakeTimers();
    try {
      const { source, announce, clock } = setup();
      // First event is solo, so it is spoken directly. The second agent flips the router into
      // multi-agent mode; everything after it defers.
      source.fire(drop({ paneId: "canvas:projA:a1", title: "Edit", body: "/r/a/one.ts" }));
      source.fire(drop({ paneId: "canvas:projB:b1", title: "Edit", body: "/r/b/two.ts" }));
      for (const f of ["three", "four", "five"]) {
        source.fire(drop({ paneId: "canvas:projA:a1", title: "Edit", body: `/r/a/${f}.ts` }));
      }

      clock.t += 10_000;
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 6);

      // "Three edits." is a counted form only summarizeFlush produces — the direct path says
      // "editing five". Asserting on a bare "edit" would pass on the spoken FIRST event alone,
      // proving nothing about the queue ever draining.
      const spoken = announce.mock.calls.map((c) => c[0]).join(" | ");
      expect(spoken).toMatch(/three edits/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing on a tick with nothing pending", async () => {
    vi.useFakeTimers();
    try {
      const { announce } = setup();
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 4);

      expect(announce).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useNarrationChannel — yields to a live voice conversation", () => {
  it("does not speak while a Live Voice session is open", async () => {
    // Two reasons, either sufficient. Talking over the user mid-conversation is simply wrong. And
    // the S2S self-trigger guard only watches its OWN player (`agentAudioRecent` in
    // use-s2s-session.ts), so narration audio reaches the open mic as an apparently genuine user
    // turn — an echo loop the session cannot see coming.
    vi.useFakeTimers();
    try {
      const { source, announce } = setup({ liveVoiceActive: true });
      source.fire(drop({ title: "Edit", body: "/r/a/auth.ts" }));
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 3);

      expect(announce).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still points the camera at a failure — the visual channel does not compete for the mic", async () => {
    vi.useFakeTimers();
    try {
      const { source, focusNode } = setup({ liveVoiceActive: true });
      source.fire(drop({ event: "tool-post-failed", title: "Bash", body: "exit 1" }));
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS);

      expect(focusNode).toHaveBeenCalledWith("node-9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dump the backlog once the session ends", async () => {
    // Holding everything and replaying it the moment the user stops talking would be worse than
    // silence: minutes-old work narrated in the present tense.
    vi.useFakeTimers();
    try {
      const { source, announce, clock, rerender } = setup({ liveVoiceActive: true });
      for (let i = 0; i < 5; i += 1) source.fire(drop({ title: "Edit", body: `/r/a/f${i}.ts` }));
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 2);

      rerender({ liveVoiceActive: false });
      clock.t += 10_000;
      await vi.advanceTimersByTimeAsync(NARRATION_TICK_MS * 3);

      expect(announce).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
