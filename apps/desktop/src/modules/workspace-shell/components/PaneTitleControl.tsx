"use client";

import { ConversationTitle } from "@/modules/conversation-title/ConversationTitle";
import { listChatThreads, regenerateChatTitle, renameChatThread } from "@/modules/chat/runtime/chat-runtime-client";
import { regeneratePaneTitle } from "@/modules/workspace-shell/hooks/usePaneAutoTitles";
import { paneTitleRename, paneTitleSource, type PaneTitlePatch } from "@/modules/workspace-shell/services/pane-title";
import type { GridCell } from "@/modules/codespace/components/types";

type ChatThreadRef = { id: string | null; title?: string };

type PaneTitleControlProps = { cell: GridCell } & PaneTitleSink;

export interface PaneTitleSink {
  /** The cell as it is NOW, read when a model's answer lands. */
  latestCell: () => GridCell | undefined;
  onTitle: (patch: PaneTitlePatch) => void;
  onChatThread: (thread: ChatThreadRef) => void;
}

/** The store decides what "" becomes (the first message's line), so a chat title is read back. */
function refreshChatTitle(id: string, onChatThread: PaneTitleSink["onChatThread"]): Promise<void> {
  return listChatThreads().then((threads) => {
    const thread = threads.find((t) => t.id === id);
    if (thread) onChatThread({ id, title: thread.title ?? undefined });
  });
}

/** A rename from the pane header or the rail's row menu: one path, so both name a pane alike. */
export function renamePane(cell: GridCell, title: string, sink: PaneTitleSink): void {
  if (cell.type === "chat") {
    const id = cell.thread?.id;
    if (!id) return;
    void renameChatThread(id, title)
      .then(() => refreshChatTitle(id, sink.onChatThread))
      .catch((error: unknown) => console.warn("[conversation-title] chat rename failed:", error));
    return;
  }
  if (cell.type !== "terminal") return;
  sink.onTitle(paneTitleRename(title, Date.now()));
  // Back to automatic: name it now rather than at the end of the next turn.
  if (!title) void regeneratePaneConversationTitle(cell, sink).catch(() => {});
}

/** A fresh model title for the pane's conversation. Throws when there is nothing to title yet. */
export function regeneratePaneConversationTitle(cell: GridCell, sink: PaneTitleSink): Promise<void> {
  if (cell.type === "chat") {
    const id = cell.thread?.id;
    return id ? regenerateChatTitle(id).then(() => refreshChatTitle(id, sink.onChatThread)) : Promise.resolve();
  }
  return regeneratePaneTitle(cell.id, sink.latestCell, sink.onTitle);
}

/**
 * The Code pane adapter for the shared `ConversationTitle`: an agent terminal's title lives on the
 * cell, a chat pane's on its thread in the chat store (so a rename here shows in Chat's rail too).
 * Other panes have no conversation and get no control — the caller asks `hasPaneConversation`.
 */
export function PaneTitleControl({ cell, latestCell, onTitle, onChatThread }: PaneTitleControlProps) {
  const sink = { latestCell, onTitle, onChatThread };
  const onRename = (title: string) => renamePane(cell, title, sink);
  const onRegenerate = () => regeneratePaneConversationTitle(cell, sink);
  if (cell.type === "chat") {
    if (!cell.thread?.id) return null;
    return <ConversationTitle title={cell.thread.title ?? ""} placeholder="New chat" onRename={onRename} onRegenerate={onRegenerate} />;
  }
  if (cell.type !== "terminal") return null;
  return (
    <ConversationTitle
      title={cell.title ?? ""}
      source={paneTitleSource(cell)}
      generating={cell.titleStatus === "generating"}
      onRename={onRename}
      onRegenerate={onRegenerate}
    />
  );
}

/** Whether a pane holds a conversation to title: an agent terminal (not a plain shell), or a chat. */
export function hasPaneConversation(cell: GridCell, hasAgent: boolean): boolean {
  if (cell.type === "chat") return Boolean(cell.thread?.id);
  return cell.type === "terminal" && hasAgent;
}
