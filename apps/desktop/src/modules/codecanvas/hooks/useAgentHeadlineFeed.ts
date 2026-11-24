"use client";

/**
 * Collects the per-agent facts a headline is made of (`plans/agent-headlines/` Slice 1).
 *
 * Mounted once per board. It subscribes to the raw hook drop stream on its **own account** and
 * writes into {@link agentStateRegistry} — the facts store from `plans/voice-narration-layer/` that
 * was built, tested, and until now had no caller anywhere in the app.
 *
 * **Why not reuse the narration channel, which already reads this stream.** That channel gates on
 * `shouldNarrate(event, profile)` and is itself mounted behind an `enabled` flag, so everything
 * downstream of it inherits the voice toggle. A card title is not a voice feature: a user with
 * narration off must still see one. This hook therefore takes no profile at all — the absence is the
 * enforcement, and a test pins it so a future "let's just reuse the narrator" cannot smuggle one in.
 *
 * Composition happens here rather than in render: the feed already holds the facts, and keeping it
 * out of render is what lets every reader be a cheap subscription to the headline store. The
 * composing itself stays a pure function in `services/agent-headline.ts`.
 */

import { useEffect } from "react";
import {
  agentStateRegistry,
  type AgentStateRegistry,
} from "../services/narration/agent-state-registry";
import {
  subscribeAgentHookEvents,
  type AgentHookSubscriber,
} from "../services/narration/use-narration-channel";
import { toNarrationEvent } from "../services/narration/narration-event";
import { publishHeadline } from "../services/agent-ask";
import {
  agentHeadlineStore,
  type AgentHeadlineStore,
} from "../services/agent-headline-store";

export interface UseAgentHeadlineFeedOptions {
  /** Injected for tests; production is the `lotus://agent-hook` Tauri event. */
  subscribeDrops?: AgentHookSubscriber;
  registry?: AgentStateRegistry;
  headlines?: AgentHeadlineStore;
  /** Injected for tests. Production reads the wall clock, for the failure-recency window. */
  now?: () => number;
}

export function useAgentHeadlineFeed({
  subscribeDrops = subscribeAgentHookEvents,
  registry = agentStateRegistry,
  headlines = agentHeadlineStore,
  now = Date.now,
}: UseAgentHeadlineFeedOptions = {}): void {
  useEffect(
    () =>
      subscribeDrops((payload) => {
        // `toNarrationEvent` returns null for drops that say nothing about the work — session
        // lifecycle, notifications. Passing those through would inflate `eventCount` and move
        // `lastEventAt` for events a headline must not react to.
        const event = toNarrationEvent(payload);
        // A drop with no LOTUS_PANE_ID cannot be attributed — codespace terminals and external CLIs
        // fire these. Without the guard they would collect under the empty string as a phantom pane.
        if (!event || !event.paneId) return;
        const state = registry.observe(event);
        // Through the shared pair rather than composing here: the typed-input path in
        // `LiveAgentNode` publishes the same way, and a second copy of compose-then-record is a
        // second place for the 2026-08-26 seam defect to reappear.
        publishHeadline(event.paneId, state, { headlines, now });
      }),
    [subscribeDrops, registry, headlines, now],
  );
}
