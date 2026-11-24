import { validateAgentName } from "@/lib/agent-catalog";
import type { GridCell } from "@/modules/codespace/components/types";

export type AgentRenameError = "empty" | "invalid-char" | "too-long" | "duplicate";

const ERROR_TEXT: Record<AgentRenameError, string> = {
  empty: "A name cannot be empty.",
  "invalid-char": "Letters, numbers, space, - and _ only.",
  "too-long": "32 characters at most.",
  duplicate: "Another pane already has this name.",
};

export function agentRenameErrorText(error: AgentRenameError): string {
  return ERROR_TEXT[error];
}

/**
 * Renames an agent pane's Agent Handle (ADR-0068). The new name must be free among the folder's
 * other panes. The old name is NOT kept as an alias: a new pane may draw it from the pool, and two
 * panes answering one name would send work to the wrong agent.
 *
 * The launch argv is left alone on purpose: a new `terminalCommand` re-creates the pane's renderer.
 * shortcut: a pane relaunched in place still starts with the old name in its system prompt; rebuild
 * the argv there (as moveTerminalToAccount does) if that path starts to matter.
 */
export function renameAgentCell(
  cells: readonly GridCell[],
  cellId: string,
  raw: string,
): { cells: GridCell[]; name: string } | { error: AgentRenameError } | null {
  const cell = cells.find((c) => c.id === cellId);
  if (!cell || cell.type !== "terminal") return null;
  const name = raw.trim();
  if (name === cell.agentName) return null;
  const taken = cells.flatMap((c) => (c.type === "terminal" && c.id !== cellId && c.agentName ? [c.agentName] : []));
  const check = validateAgentName(name, taken);
  if (!check.ok) return { error: check.reason };
  return { cells: cells.map((c) => (c.id === cellId ? { ...cell, agentName: name } : c)), name };
}
