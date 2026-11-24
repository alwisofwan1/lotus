import type { ChatCellData, Workspace } from "@/modules/codespace/components/types";
import { requestThreadDraft } from "@/modules/codespace/state/thread-draft-inbox";

/*
 * Code mode's answer to ⌘L (`selection-send.ts`): which Thread's composer a selection lands in.
 */

type RouteSelectionInput = {
  workspace: Workspace;
  /** The Thread pane used last in this workspace. Not the focused pane: that is the Editor. */
  preferredThreadId: string | null;
  /** The Editor pane the selection came from; a new Thread opens beside it. */
  sourceCellId: string;
  text: string;
  /** Opens a Thread pane beside `sourceCellId`; null when none can be made. */
  addThreadPane: (sourceCellId: string) => { paneId: string; sessionId: string } | null;
};

export type RouteSelectionResult =
  | { ok: true; paneId: string; created: boolean }
  | { ok: false; reason: string };

/** The Thread used last, else the first one, else a new one — never more than one new pane. */
export function routeSelectionToThread({
  workspace,
  preferredThreadId,
  sourceCellId,
  text,
  addThreadPane,
}: RouteSelectionInput): RouteSelectionResult {
  // A pane that lost its conversation has no composer to fill.
  const threads = workspace.cells.filter(
    (cell): cell is ChatCellData => cell.type === "chat" && Boolean(cell.sessionId || cell.thread),
  );
  const existing = threads.find((cell) => cell.id === preferredThreadId) ?? threads[0];
  if (existing) {
    // A new-chat pane (07d) takes drafts under its own id, as it takes sends.
    requestThreadDraft(existing.thread ? existing.id : existing.sessionId, text);
    return { ok: true, paneId: existing.id, created: false };
  }
  const created = addThreadPane(sourceCellId);
  if (!created) return { ok: false, reason: "A new Thread could not be opened here." };
  requestThreadDraft(created.sessionId, text);
  return { ok: true, paneId: created.paneId, created: true };
}
