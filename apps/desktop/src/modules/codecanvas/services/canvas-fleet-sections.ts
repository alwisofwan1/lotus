/**
 * The Fleet panel's contents: every cell on the board, once (`plans/canvas-fleet-panel/` S1).
 *
 * **Once is the whole point.** The panel this replaces rendered three overlapping lists — a
 * needs-you lane, an inbox grouped by status bucket, and a Processes tree grouped by edges — so
 * every agent appeared twice in the same column. Reading it meant reconciling two rows about the
 * same thing.
 *
 * Pure, and takes its headline reader as an argument, so the whole section layout is testable
 * without a DOM or a store.
 */

import type { Node } from "@xyflow/react";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import type { AgentNodeStatus } from "../types/canvas";
import { formatWaiting } from "./needs-you-queue";
import {
  describeCanvasNode,
  isCanvasNavigatorType,
  type CanvasNavigatorType,
} from "./canvas-node-view";

export type FleetSectionId = "agents" | "windows" | "cards";

export const FLEET_SECTION_TITLE: Record<FleetSectionId, string> = {
  agents: "Agents",
  windows: "Windows",
  cards: "Cards",
};

/**
 * Which section each node type belongs to.
 *
 * The reference design has two sections; Lotus has twelve node types, so a two-section list would
 * have nowhere to put a note, a plan or a task. The agent FAMILY stays together — a team, a critic
 * and a human-gate are part of the agent flow, and burying a blocking human-gate among sticky notes
 * would hide the one row asking for a decision.
 */
const SECTION_OF: Record<CanvasNavigatorType, FleetSectionId> = {
  agent: "agents",
  team: "agents",
  critic: "agents",
  "human-gate": "agents",
  terminal: "windows",
  browser: "windows",
  task: "cards",
  context: "cards",
  plan: "cards",
  note: "cards",
  skills: "cards",
  skill: "cards",
};

/** Rendered order. Agents first because they are the reason anyone opens this panel. */
const SECTION_ORDER: FleetSectionId[] = ["agents", "windows", "cards"];

/**
 * What a state looks like in words.
 *
 * Two jobs. It answers "what is this one doing" for an agent nobody has asked anything yet — which
 * is most of a freshly spawned board — and it settles an accessibility requirement PRODUCT.md is
 * explicit about: state was carried by dot colour alone, and colour alone is not an indicator.
 *
 * Operational words, not friendly ones. "working" and "quiet" say what is true; "thinking" or
 * "hard at work" would be narration this product's voice deliberately avoids.
 */
export const STATUS_PHRASE: Record<AgentNodeStatus, string> = {
  connecting: "starting",
  running: "working",
  idle: "ready",
  "needs-you": "needs you",
  completed: "finished",
  error: "failed",
  stalled: "quiet",
};

/** Types whose second line is a headline rather than the descriptor's own detail. */
const HEADLINE_TYPES = new Set<CanvasNavigatorType>(["agent", "team", "critic", "human-gate"]);

export interface FleetRow {
  id: string;
  type: CanvasNavigatorType;
  /** The name, as the node's own header prints it. */
  label: string;
  /**
   * The second line: what this cell is FOR. An agent's headline, else whatever identifies it.
   *
   * State used to compete for this slot, and win or lose depending on whether a headline had
   * arrived — so an agent that had been given a task showed no status at all, and one that had not
   * showed status but nothing about itself. The row chose one of three facts and dropped the rest.
   * State now has {@link state} to itself and this line only ever carries context.
   */
  detail: string;
  /**
   * Which kind of context this is: something the operator asked for, or something that identifies
   * the cell. Rendering them identically would let a cwd read as an instruction.
   */
  detailKind: "ask" | "identity";
  /**
   * The third line: what it is doing right now, and for how long.
   *
   * Its own slot rather than a fallback for {@link detail}. Absent for cells that have no live
   * status at all — a note is not idle, it simply has no state to be in.
   */
  state?: string;
  /** Live launch status, for the dot. Absent for cells that do not have one. */
  status?: AgentNodeStatus;
}

export interface FleetSection {
  id: FleetSectionId;
  title: string;
  rows: FleetRow[];
}

export function fleetSections(
  nodes: readonly Node[],
  liveStatuses: readonly AgentStatusSnapshot[],
  /**
   * Reads the headline store, which is keyed by **pane id** — not node id.
   *
   * Named for what it takes, because getting this wrong is silent: the store simply returns
   * `undefined` and the row falls through to its next fallback, so a broken lookup looks exactly
   * like an agent that has not been asked anything.
   */
  headlineFor: (paneId: string) => string | undefined,
  /** Now, for the time-in-state suffix. Omit to print the bare state word. */
  now?: number,
): FleetSection[] {
  const liveById = new Map(liveStatuses.map((snapshot) => [snapshot.id, snapshot]));
  const rowsBySection = new Map<FleetSectionId, FleetRow[]>();

  nodes.forEach((node, index) => {
    // An unknown type comes from a newer board or a node kind this build predates. Filing it under
    // `cards` would put an unlabelled row in front of the operator; leaving it out is honest.
    if (!isCanvasNavigatorType(node.type)) return;
    const type = node.type;
    const live = liveById.get(node.id);
    // Already pinned at the top of the panel. Repeating it below is the duplication this list exists
    // to remove.
    if (live?.status === "needs-you") return;

    const descriptor = describeCanvasNode(node, index, live);
    // Scoped to the agent family: a terminal's stable number/custom label plus compact cwd context
    // identify it, and a key collision must not be able to rewrite that context.
    //
    // **By pane id, not node id.** `agentHeadlineStore` is written by `useAgentHeadlineFeed` under
    // the pane id, and `canvasRuntimePaneId` makes that `canvas:<projectId>:<nodeId>` whenever a
    // project is open — which is always, on a real board. So this lookup could never match and the
    // Fleet rail has never shown a headline in its life. It failed silently: a missed key returns
    // `undefined`, which is indistinguishable from an agent nobody has asked anything.
    //
    // The needs-you lane, reading the same store, keys on `entry.paneId` and has always worked.
    // That contrast is what gave this away.
    //
    // `hookPaneId` is published beside `id` on every snapshot for exactly this reason. The fallback
    // covers a cell with no live entry, where node id is all there is.
    const paneId = live?.hookPaneId ?? node.id;
    const headline = HEADLINE_TYPES.has(type) ? headlineFor(paneId)?.trim() : undefined;
    // Trimmed before the `||` chain: `describeCanvasNode` returns the agent's model, and its guard
    // is `typeof model === "string"` — which an EMPTY string passes. Bare launches are the norm
    // (ADR-0027: "a launched runner is just the CLI, no baked role/model"), so this was silently ""
    // and every agent row shipped blank under its name.
    // `describeCanvasNode` falls back to the type word when a cell has nothing to say about itself
    // ("note" for an empty note). Under a label that already reads "Note 2", beside a note icon,
    // that is a line spent restating what two other things said.
    const rawDetail = descriptor.detail.trim();
    const descriptorDetail = rawDetail.toLowerCase() === type ? "" : rawDetail;
    // The ask first: it is what THIS agent was told to do. The model stays as the fallback rather
    // than being dropped — it is still a fact, and it is the only one left when nothing has been
    // asked yet.
    //
    // What is NO LONGER in this chain is the state. It used to sit between the two, which meant an
    // agent with a headline reported no status and an agent without one said nothing about itself.
    // Three facts, one slot, two of them discarded on every render. The state has its own line now.
    //
    // A terminal's name/location and a note's first line are IDENTITY, not mood, so no state phrase
    // may displace them.
    // `quiet` on its own is unactionable; `quiet · 42m` is the row worth opening, and `quiet · 1m`
    // is the row to leave alone. Same word, and the duration is what makes it mean something.
    // The formatter is the needs-you lane's, so a wait in one place can never read differently in
    // the other.
    const since =
      now !== undefined && live?.statusChangedAt !== undefined
        ? formatWaiting(Math.max(0, now - live.statusChangedAt))
        : "";
    const statePhrase = live?.status
      ? since
        ? `${STATUS_PHRASE[live.status]} · ${since}`
        : STATUS_PHRASE[live.status]
      : "";
    /**
     * The floor under the context line: the runner's own name.
     *
     * `describeCanvasNode` gives an agent its MODEL, and a bare launch has none — ADR-0027 says a
     * launched runner is just the CLI with no baked role or model, and that is the commonest agent
     * on any board. So the context line was blank for exactly the rows that fill a fresh canvas.
     *
     * This reverses a call recorded a few lines above, which dropped the model because it is
     * "identical across agents and already implied by the runner glyph". Two things changed. The
     * glyph argument was about the MODEL; `runnerLabel` is the runner's own name as the node's
     * header prints it — `Claude Code`, `Codex`, `acme` — and a board mixing runners is now
     * ordinary. And a glyph is a picture: it can be recognised, but it cannot be read out, searched,
     * or copied, and it is 13px wide on a panel that scales with the board's zoom.
     *
     * It is a floor, not a preference. A live headline still wins, and always should: what an agent
     * is DOING beats what it is.
     */
    const runnerLabel = live?.runnerLabel?.trim() ?? "";
    const [detail, detailKind]: [string, FleetRow["detailKind"]] = HEADLINE_TYPES.has(type)
      ? headline
        ? [headline, "ask"]
        : [descriptorDetail || runnerLabel, "identity"]
      : [descriptorDetail, "identity"];

    const section = SECTION_OF[type];
    const rows = rowsBySection.get(section) ?? [];
    rows.push({
      id: node.id,
      type,
      label: descriptor.label,
      detail,
      detailKind,
      ...(statePhrase ? { state: statePhrase } : {}),
      // From the snapshot, not the descriptor: the descriptor merely echoes back the status we
      // passed in, and widens it to `string` on the way. This is the typed original.
      ...(live?.status ? { status: live.status } : {}),
    });
    rowsBySection.set(section, rows);
  });

  // An empty heading is a promise of content that is not there.
  return SECTION_ORDER.filter((id) => (rowsBySection.get(id)?.length ?? 0) > 0).map((id) => ({
    id,
    title: FLEET_SECTION_TITLE[id],
    rows: rowsBySection.get(id)!,
  }));
}
