/**
 * Recording an operator's ask against a pane, whatever runner it is
 * (`plans/agent-headlines/` — headlines for every runner).
 *
 * For Claude-family agents the ask arrives on a `prompt-submit` hook drop and
 * {@link useAgentHeadlineFeed} handles it. Codex reports only turn ends, and `cursor` and `custom`
 * report nothing — so this is the path that covers the rest of the fleet, reading the ask from the
 * PTY write stream itself (see `pane-ask-buffer.ts`). It also covers work no human typed: an MCP
 * dispatch goes through the same choke point.
 *
 * **Why `publishHeadline` is extracted rather than written at each call site.** Composing a headline
 * and recording it are a pair, and the pair is where the 2026-08-26 defect lived: the composer
 * offered a line the store was guaranteed to discard, and unit tests on either side could not see it.
 * Two copies of that pair would be two places for it to come back. One function, two callers.
 */

import { headlineOf } from "./agent-headline";
import { agentHeadlineStore, type AgentHeadlineStore } from "./agent-headline-store";
import {
  agentStateRegistry,
  type AgentState,
  type AgentStateRegistry,
} from "./narration/agent-state-registry";

export interface AgentAskDeps {
  registry?: AgentStateRegistry;
  headlines?: AgentHeadlineStore;
  now?: () => number;
}

/** Compose this pane's headline from its facts and offer it to the store. */
export function publishHeadline(
  paneId: string,
  state: AgentState,
  { headlines = agentHeadlineStore, now = Date.now }: AgentAskDeps = {},
): void {
  // Offered, not imposed: the store holds what is displayed unless the key changed.
  headlines.record(paneId, headlineOf(state, now()));
}

/**
 * Note that a human (or a dispatch) just asked this pane for something.
 *
 * Deliberately touches only `lastPrompt` and `turnActive`. `eventCount` and `lastEventAt` are what
 * `salienceOf` ranks the voice narrator's attention by, and they are fed by hook drops; moving them
 * from a keystroke would make a pane sound freshly active on a channel narration never observed.
 */
export function noteAgentAsk(paneId: string, ask: string, deps: AgentAskDeps = {}): void {
  const { registry = agentStateRegistry } = deps;
  const state = registry.noteAsk(paneId, ask);
  publishHeadline(paneId, state, deps);
}
