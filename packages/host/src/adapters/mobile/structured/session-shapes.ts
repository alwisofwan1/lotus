import type { ConversationUpdate } from "../../../types/conversation.js";
import type { FleetMember } from "../../../types/fleet.js";
import type { AgentStopEvent } from "../../../types/notifications.js";
import type { BridgeProvider } from "../../../types/api.js";
import type { BridgeRegistry } from "./bridge-registry.js";
import type { CellBook } from "./cell-book.js";
import type { CreateCodexSession } from "./bridges/codex.js";

export interface StructuredSpawnRequest {
  workspaceId: string;
  workspaceLabel?: string;
  cwd: string;
  title?: string;
  initialPrompt?: string;
  /** Which runner to start. Absent: Codex, the only structured runner before the seam existed. */
  agentType?: BridgeProvider;
  /** A stop from that runner's advertised scale. Absent: the runner's own default. */
  permissionMode?: string;
  /** Which authenticated account to run as. Absent: the runner's own default. */
  profileId?: string;
  /**
   * What the operator reads for this cell, when it is not the bridge's own name.
   *
   * A `ccs initech` cell runs the Claude bridge — same binary, same protocol — under that
   * account's config dir, so its family is `claude` and calling it *Claude Code* in the fleet
   * would hide the one thing that distinguishes it.
   */
  runnerLabel?: string;
  model?: string;
  effort?: string;
}

export interface StructuredSessionsDeps {
  /** A `notification` frame for connected phones — the same channel the hook pipeline uses. */
  publishNotification: (event: AgentStopEvent) => void;
  /**
   * The same step as a `Part`, for a phone that reads the conversation lane.
   *
   * Both are published for every step, on purpose (ADR-4): the entry keeps older phones
   * working, and this carries what an entry cannot — a streaming text part being revised,
   * a tool status moving, a turn closing with its stop reason.
   */
  publishConversation?: (paneId: string, agentType: string, update: ConversationUpdate) => void;
  /** The fleet changed shape (a session started or ended). */
  fleetChanged: () => void;
  /** Swappable so tests never spawn a binary. Kept as a Codex-shaped seam for the tests that predate the registry. */
  createSession?: CreateCodexSession;
  /** Which runners this host can start. Defaults to every bridge whose binary is present. */
  registry?: BridgeRegistry;
  /** Where cells are saved so `restore` can bring them back after a host restart. Absent: nothing survives one. */
  book?: CellBook;
}
