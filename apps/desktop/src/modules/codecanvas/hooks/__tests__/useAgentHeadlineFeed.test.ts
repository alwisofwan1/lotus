import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAgentHeadlineFeed } from "../useAgentHeadlineFeed";
import { createAgentStateRegistry } from "../../services/narration/agent-state-registry";
import { createAgentHeadlineStore } from "../../services/agent-headline-store";
import type { AgentHookDropPayload } from "../../services/narration/narration-event";

const NOW = 1_700_000_000_000;

function drop(over: Partial<AgentHookDropPayload> = {}): AgentHookDropPayload {
  return {
    version: 1,
    sessionId: null,
    agentType: "claude",
    event: "tool-pre",
    status: "running",
    title: "Edit",
    body: "/repo/src/auth/login.ts",
    userPrompt: "",
    cwd: "/repo",
    pid: null,
    agentPid: null,
    paneId: "canvas:cp_1:a1",
    timestamp: NOW,
    ...over,
  };
}

/** A drop transport the test drives, standing in for `lotus://agent-hook`. */
function transport() {
  let push: ((payload: AgentHookDropPayload) => void) | undefined;
  const unsubscribe = vi.fn();
  return {
    unsubscribe,
    emit: (payload: AgentHookDropPayload) => push?.(payload),
    isSubscribed: () => push !== undefined,
    subscribe: (onDrop: (payload: AgentHookDropPayload) => void) => {
      push = onDrop;
      return unsubscribe;
    },
  };
}

describe("useAgentHeadlineFeed", () => {
  it("records the tool a pane is running", () => {
    const registry = createAgentStateRegistry();
    const t = transport();

    renderHook(() => useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry }));
    t.emit(drop({ event: "tool-pre", title: "Edit" }));

    expect(registry.get("canvas:cp_1:a1")?.currentTool).toBe("edit");
  });

  it("accumulates the files a pane has touched", () => {
    const registry = createAgentStateRegistry();
    const t = transport();

    renderHook(() => useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry }));
    t.emit(drop({ event: "tool-post", title: "Edit", body: "/repo/src/auth/login.ts" }));
    t.emit(drop({ event: "tool-post", title: "Write", body: "/repo/src/auth/token.ts" }));

    expect(registry.get("canvas:cp_1:a1")?.filesTouched).toEqual([
      "/repo/src/auth/login.ts",
      "/repo/src/auth/token.ts",
    ]);
  });

  it("keeps panes apart", () => {
    const registry = createAgentStateRegistry();
    const t = transport();

    renderHook(() => useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry }));
    t.emit(drop({ paneId: "canvas:cp_1:a1", title: "Edit" }));
    t.emit(drop({ paneId: "canvas:cp_1:a2", title: "Bash" }));

    expect(registry.get("canvas:cp_1:a1")?.currentTool).toBe("edit");
    expect(registry.get("canvas:cp_1:a2")?.currentTool).toBe("bash");
  });

  it("ignores a drop that is not narration-relevant", () => {
    // `session-start`, `notification` and friends map to no narration kind. Passing them through
    // would inflate `eventCount` and move `lastEventAt` for events that say nothing about the work.
    const registry = createAgentStateRegistry();
    const t = transport();

    renderHook(() => useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry }));
    t.emit(drop({ event: "session-start" }));

    expect(registry.get("canvas:cp_1:a1")).toBeUndefined();
  });

  it("never reads the narration profile", () => {
    // The load-bearing invariant. A headline is not a voice feature: a user with narration off must
    // still see one. The narration channel gates its own subscription on `shouldNarrate`; this feed
    // subscribes on its own account and takes no profile at all — enforced by the absence of any
    // profile in its options, and pinned here so a future "reuse" cannot smuggle one in.
    const registry = createAgentStateRegistry();
    const t = transport();

    renderHook(() => useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry }));

    expect(t.isSubscribed()).toBe(true);
    expect(registry.version()).toBe(0);
  });

  it("drops the subscription on unmount", () => {
    const registry = createAgentStateRegistry();
    const t = transport();

    const { unmount } = renderHook(() =>
      useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry }),
    );
    unmount();

    expect(t.unsubscribe).toHaveBeenCalled();
  });

  it("survives a payload with no pane id", () => {
    // Codespace terminals and external CLIs fire hooks with no LOTUS_PANE_ID. There is nothing to
    // attribute those to, and they must not become a pane keyed on the empty string.
    const registry = createAgentStateRegistry();
    const t = transport();

    renderHook(() => useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry }));
    t.emit(drop({ paneId: null }));

    expect(registry.all()).toEqual([]);
  });

  it("publishes a headline for the pane it observed", () => {
    // Composition happens here rather than in render: the feed already holds the facts, and keeping
    // it out of render is what lets the readers be a cheap subscription.
    const registry = createAgentStateRegistry();
    const headlines = createAgentHeadlineStore();
    const t = transport();

    renderHook(() =>
      useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry, headlines }),
    );
    t.emit(drop({ event: "tool-pre", title: "Bash" }));

    expect(headlines.get("canvas:cp_1:a1")).toBe("running a command");
  });

  it("holds the published line across the tense flip that follows every tool call", () => {
    // The measured churn, end to end: pre → post is one tool call and must read as one headline.
    const registry = createAgentStateRegistry();
    const headlines = createAgentHeadlineStore();
    const t = transport();

    renderHook(() =>
      useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry, headlines }),
    );
    t.emit(drop({ event: "tool-pre", title: "Bash", body: "bun run test" }));
    const afterPre = headlines.version();
    // A Bash tool-post carries no target at all — measured, and why the area cannot appear here.
    t.emit(drop({ event: "tool-post", title: "Tool", body: "" }));

    expect(headlines.get("canvas:cp_1:a1")).toBe("running a command");
    expect(headlines.version()).toBe(afterPre);
  });

  it("moves the line when the agent switches tools", () => {
    const registry = createAgentStateRegistry();
    const headlines = createAgentHeadlineStore();
    const t = transport();

    renderHook(() =>
      useAgentHeadlineFeed({ subscribeDrops: t.subscribe, registry, headlines }),
    );
    t.emit(drop({ event: "tool-pre", title: "Bash" }));
    t.emit(drop({ event: "tool-pre", title: "Edit" }));

    expect(headlines.get("canvas:cp_1:a1")).toBe("editing");
  });
});

describe("the feed and the store as a pair, across a whole turn", () => {
  // The test class that was missing, and the reason a defect reached the operator on 2026-08-26.
  //
  // `agent-headline.ts` and `agent-headline-store.ts` are designed to work as a pair: the composer
  // OFFERS a line, the store decides whether to show it. Every test either side of that seam passed
  // while the pair as a whole was broken — the composer's past-tense branch was real, and the store
  // was guaranteed to discard it, so a finished agent's card kept saying "running a command" beside
  // an IDLE badge. Neither unit could see it. This drives the real registry and the real store with
  // the drop sequence a real turn produces, and asserts what a human would actually read.

  it("holds one line while the turn runs, then switches to the past when it ends", () => {
    const t = transport();
    const registry = createAgentStateRegistry();
    const headlines = createAgentHeadlineStore();
    renderHook(() =>
      useAgentHeadlineFeed({
        subscribeDrops: t.subscribe,
        registry,
        headlines,
        now: () => NOW,
      }),
    );

    t.emit(drop({ event: "prompt-submit", title: "", body: "run the tests" }));
    t.emit(drop({ event: "tool-pre", title: "Bash", body: "bun run test" }));
    const running = headlines.get("canvas:cp_1:a1");

    t.emit(drop({ event: "tool-post", title: "Bash", body: "" }));
    const between = headlines.get("canvas:cp_1:a1");

    t.emit(drop({ event: "tool-pre", title: "Bash", body: "bun run lint" }));
    t.emit(drop({ event: "tool-post", title: "Bash", body: "" }));
    const stillRunning = headlines.get("canvas:cp_1:a1");

    t.emit(drop({ event: "stop", title: "", body: "all green" }));

    expect(running).toBe("running a command");
    // The churn the key was introduced to absorb — two tool calls, and the line never moves.
    expect(between).toBe("running a command");
    expect(stillRunning).toBe("running a command");
    // And the part that never used to happen.
    expect(headlines.get("canvas:cp_1:a1")).toBe("ran a command");
  });

  it("goes back to the present tense on the next turn", () => {
    const t = transport();
    const registry = createAgentStateRegistry();
    const headlines = createAgentHeadlineStore();
    renderHook(() =>
      useAgentHeadlineFeed({
        subscribeDrops: t.subscribe,
        registry,
        headlines,
        now: () => NOW,
      }),
    );
    t.emit(drop({ event: "tool-pre", title: "Bash", body: "bun run test" }));
    t.emit(drop({ event: "stop", title: "", body: "done" }));

    t.emit(drop({ event: "tool-pre", title: "Bash", body: "bun run test" }));

    expect(headlines.get("canvas:cp_1:a1")).toBe("running a command");
  });

  it("does not let a turn end invent a headline for an agent that ran no tools", () => {
    // `stop` now reaches a branch it never used to. A pane that only ever submitted a prompt has
    // done nothing worth titling, and the honest answer stays nothing at all.
    const t = transport();
    const registry = createAgentStateRegistry();
    const headlines = createAgentHeadlineStore();
    renderHook(() =>
      useAgentHeadlineFeed({
        subscribeDrops: t.subscribe,
        registry,
        headlines,
        now: () => NOW,
      }),
    );

    t.emit(drop({ event: "prompt-submit", title: "", body: "hello" }));
    t.emit(drop({ event: "stop", title: "", body: "hi there" }));

    expect(headlines.get("canvas:cp_1:a1")).toBeUndefined();
  });
});

describe("the ask reaching the card", () => {
  // End to end through the real registry and the real store, because the seam is where the previous
  // defect lived. `run-hook.mjs` fills BOTH `body` and `userPrompt` from the prompt payload on a
  // prompt-submit drop, and `toNarrationEvent` reads `userPrompt` for that event — so the fixtures
  // here set it the way a real hook does.

  const feed = () => {
    const t = transport();
    const registry = createAgentStateRegistry();
    const headlines = createAgentHeadlineStore();
    renderHook(() =>
      useAgentHeadlineFeed({
        subscribeDrops: t.subscribe,
        registry,
        headlines,
        now: () => NOW,
      }),
    );
    return { t, headlines, read: () => headlines.get("canvas:cp_1:a1") };
  };

  it("titles the card with what the operator asked for", () => {
    const { t, read } = feed();

    t.emit(drop({
      event: "prompt-submit",
      title: "",
      body: "jelaskan perubahan yang belum commit di branch ini",
      userPrompt: "jelaskan perubahan yang belum commit di branch ini",
    }));

    expect(read()).toBe("jelaskan perubahan yang belum commit di branch ini");
  });

  it("holds the ask steady through every tool the turn runs", () => {
    // The whole complaint, in one test. This sequence used to read "running a command" from the
    // first tool to the last, identically for every Bash-heavy agent on the board.
    const { t, read } = feed();
    t.emit(drop({
      event: "prompt-submit",
      title: "",
      body: "run the tests",
      userPrompt: "run the tests",
    }));

    t.emit(drop({ event: "tool-pre", title: "Bash", body: "bun run test" }));
    const during = read();
    t.emit(drop({ event: "tool-post", title: "Bash", body: "" }));
    t.emit(drop({ event: "tool-pre", title: "Edit", body: "/repo/src/auth/login.ts" }));
    t.emit(drop({ event: "tool-post", title: "Edit", body: "/repo/src/auth/login.ts" }));
    t.emit(drop({ event: "stop", title: "", body: "all green" }));

    expect(during).toBe("run the tests");
    expect(read()).toBe("run the tests");
  });

  it("moves on when the next ask arrives", () => {
    const { t, read } = feed();
    t.emit(drop({
      event: "prompt-submit",
      title: "",
      body: "run the tests",
      userPrompt: "run the tests",
    }));
    t.emit(drop({ event: "stop", title: "", body: "done" }));

    t.emit(drop({
      event: "prompt-submit",
      title: "",
      body: "now fix the lint",
      userPrompt: "now fix the lint",
    }));

    expect(read()).toBe("now fix the lint");
  });

  it("gives two agents on one board two different titles", () => {
    // The property the tool-name headline could not deliver at all, and the reason it was useless:
    // both of these would have read "running a command".
    const t = transport();
    const registry = createAgentStateRegistry();
    const headlines = createAgentHeadlineStore();
    renderHook(() =>
      useAgentHeadlineFeed({
        subscribeDrops: t.subscribe,
        registry,
        headlines,
        now: () => NOW,
      }),
    );

    t.emit(drop({
      paneId: "canvas:cp_1:a1",
      event: "prompt-submit",
      title: "",
      body: "run the tests",
      userPrompt: "run the tests",
    }));
    t.emit(drop({ paneId: "canvas:cp_1:a1", event: "tool-pre", title: "Bash", body: "bun test" }));
    t.emit(drop({
      paneId: "canvas:cp_1:a2",
      event: "prompt-submit",
      title: "",
      body: "perbaiki judul agent yang beku",
      userPrompt: "perbaiki judul agent yang beku",
    }));
    t.emit(drop({ paneId: "canvas:cp_1:a2", event: "tool-pre", title: "Bash", body: "bun test" }));

    expect(headlines.get("canvas:cp_1:a1")).toBe("run the tests");
    expect(headlines.get("canvas:cp_1:a2")).toBe("perbaiki judul agent yang beku");
  });

  it("falls back to the tool line for a pane whose ask it never saw", () => {
    // Reconnects and reopened boards attach mid-turn. Worth less than the ask, better than nothing.
    const { t, read } = feed();

    t.emit(drop({ event: "tool-pre", title: "Edit", body: "/repo/src/auth/login.ts" }));

    expect(read()).toBe("editing");
  });
});

