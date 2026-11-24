import type { AgentStopEvent } from "../../../types/notifications.js";
import type { FleetMember } from "../../../types/fleet.js";
import type { ConversationPage, Turn } from "../../../types/conversation.js";
import type { ProviderBridgeFactory, ProviderBridgeSession } from "../../../types/provider-bridge.js";
import type { SavedSpawn } from "./cell-book.js";
import { nextCellName } from "../../../core/cell-names.js";
import type { entryFromPart } from "./entries-from-parts.js";
import type { StructuredSpawnRequest } from "./session-shapes.js";

/** A new structured cell as the fleet sees it. `titles` are the names already taken. */
export function cellMember(paneId: string, req: StructuredSpawnRequest, bridge: ProviderBridgeFactory, titles: string[]): FleetMember {
  return {
    paneId, workspaceId: req.workspaceId, agentType: bridge.agentType,
    runnerLabel: req.runnerLabel ?? bridge.runnerLabel,
    // NOT the runner label, which is what this used to fall back to. A cell named after its
    // binary is a cell with no name: two claude cells both read "Claude Code", in the fleet, in
    // the desktop's adopt list, and in the push notification that says one of them needs you.
    // The label still travels — one field up, where it answers its own question.
    title: req.title ?? nextCellName(titles),
    status: "live", isAlive: true, cwd: req.cwd,
    ...(req.workspaceLabel === undefined ? {} : { workspaceLabel: req.workspaceLabel }),
    ...(req.initialPrompt === undefined ? {} : { headline: req.initialPrompt.split("\n")[0] ?? "" }),
    // Derived from what the session was actually started with, not from the request: a
    // mode this host did not recognise falls back to asking, and a member that claimed
    // `skipped` there would be describing a cell that is in fact waiting for an answer.
    gating: bridge.gating(req.permissionMode),
    // Remembered on the member, not derived: an operator with three accounts needs to read
    // which one a cell is working as, and the cell cannot be moved once running.
    ...(req.profileId === undefined ? {} : { profileId: req.profileId }),
  };
}

type Entry = NonNullable<ReturnType<typeof entryFromPart>>;

/** One step as the hook-vocabulary frame phones in the field already render. */
export function stepNotification(member: FleetMember, entry: Entry): AgentStopEvent {
  return {
    kind: "agent_stop", pane_id: member.paneId, workspace_id: member.workspaceId, agent_type: member.agentType,
    event: entry.event, title: entry.title, body: entry.body, status: entry.status,
    user_prompt: entry.userPrompt, tool_target: entry.toolTarget, cwd: member.cwd ?? "", timestamp: entry.timestamp,
    ...(entry.bodyTruncated ? { body_truncated: true } : {}),
    ...(entry.linesAdded === undefined ? {} : { lines_added: entry.linesAdded }),
    ...(entry.linesRemoved === undefined ? {} : { lines_removed: entry.linesRemoved }),
  };
}

/** A structured cell this store holds. */
export interface Held {
  member: FleetMember;
  session: ProviderBridgeSession;
  turn: "running" | "idle" | "needs-input";
  turnChangedAt: number;
  lastOpenTurnId?: string;
  spawn: SavedSpawn;
  /** Turns from before the last host restart; the runner's own page starts empty again. */
  prior: Turn[];
  /** Tags this run's turn ids when saved, since a resumed runner counts from zero again. */
  gen: string;
  /** The id this run resumed: Claude names its session only after its first answer, so a save before that keeps this one. */
  resumed?: string;
}

/** The text that ends a turn is the last one before the turn closed — Codex tags it `final_answer`. */
export function isClosingText(page: ConversationPage, turnId: string, partId: string): boolean {
  const turn = page.turns.find((t) => t.turnId === turnId);
  if (turn === undefined) return false;
  const texts = turn.parts.filter((p) => p.type === "assistant_text");
  return turn.endedAt !== undefined && texts.at(-1)?.id === partId;
}
