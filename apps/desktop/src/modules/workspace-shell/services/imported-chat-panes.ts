import type { ChatThread } from "@/modules/chat/runtime/chat-runtime-client";
import type { ChatCellData, Workspace } from "@/modules/codespace/components/types";

/**
 * 07f: a CodeChat pane opened before 07d holds a CodeChat `sessionId`. Once that session has been
 * imported (#290), the new chat has it under a new id, found through `importedFrom`. The pane is
 * moved to that thread; the CodeChat session itself is left as it was.
 */
export interface ImportedPane {
  workspaceId: string;
  cellId: string;
  thread: NonNullable<ChatCellData["thread"]>;
}

/** Panes holding a CodeChat session, and whether each shows a thread now: changes only when that does. */
export function codeChatPaneKey(workspaces: readonly Workspace[]): string {
  return workspaces
    .flatMap((w) => w.cells.filter((c) => c.type === "chat" && c.sessionId).map((c) => `${w.id}/${c.id}${c.type === "chat" && c.thread ? " thread" : ""}`))
    .join("\n");
}

export function importedChatPanes(workspaces: readonly Workspace[], threads: readonly ChatThread[]): ImportedPane[] {
  const byImport = new Map(threads.filter((t) => t.importedFrom).map((t) => [t.importedFrom, t]));
  return workspaces.flatMap((w) =>
    w.cells.flatMap((c) => {
      const t = c.type === "chat" && !c.thread && c.sessionId ? byImport.get(c.sessionId) : undefined;
      return t ? [{ workspaceId: w.id, cellId: c.id, thread: { id: t.id, ...(t.title ? { title: t.title } : {}) } }] : [];
    }),
  );
}
