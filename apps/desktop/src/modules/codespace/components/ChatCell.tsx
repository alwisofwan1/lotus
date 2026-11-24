"use client";

import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { useThreadComposerRegistry } from "@/modules/codespace/state/thread-composer-registry";
import { chatPaneThreads, threadActivityRegistry } from "@/modules/codespace/state/thread-activity-registry";
import { onThreadDraft, takeThreadDraft } from "@/modules/codespace/state/thread-draft-inbox";
import type { ChatCellData } from "@/modules/codespace/components/types";
import { openFileLinkInWorkspace } from "@/modules/codespace/services/workbench-open";
import { ChatPage, useChatRail, type ChatPaneMode, type ChatRail } from "@/modules/chat/ui/ChatPage";
import { Dither } from "@/modules/chat/ui/Dither";

interface ChatCellProps {
  cell: ChatCellData;
  /** File links in answers open in this workspace's Editor pane. */
  workspaceId?: string;
  /** New Chat (beta, 07d): records the thread a pane's first message created, or null to start over. */
  onThreadChange?: (thread: NonNullable<ChatCellData["thread"]>) => void;
  /** Closes this pane. */
  onClose?: () => void;
  /** The pane header's own spot (`PaneHeaderSlot`): the chat's Done goes there. */
  headerSlot?: HTMLElement | null;
  /** The pane has focus: ⌘⇧E is this chat's Done. */
  focused?: boolean;
}

/**
 * A conversation, running inside a workspace pane. A pane from before 07d holds only a CodeChat
 * session id; it opens as a new chat until CodeMode moves it to the thread that session was
 * imported into (07f).
 */
export function ChatCell(props: ChatCellProps) {
  return <NewChatCell {...props} thread={props.cell.thread ?? NO_THREAD} />;
}

const NO_THREAD: NonNullable<ChatCellData["thread"]> = { id: null };

/** A glow rising under the "deleted" line, in the clay of the delete confirm. */
const glow = (u: number, v: number) => Math.max(0, 1 - Math.hypot((u - 0.5) * 2.1, (v - 0.95) * 2.4)) ** 1.6;

/**
 * The new chat in a Code pane (New Chat (beta), 07d; mockups/lotus-chat.fig, "07d Code panes").
 *
 * The Chat (beta) column itself, in pane mode. The pane holds the thread id; the chat runtime
 * holds the thread, so Chat mode lists the same one. Send and activity are registered under the
 * PANE's id, which exists before the thread does.
 */
function NewChatCell({
  cell,
  workspaceId,
  onThreadChange,
  onClose,
  headerSlot,
  focused,
  thread,
}: ChatCellProps & { thread: NonNullable<ChatCellData["thread"]> }) {
  const all = useChatRail();
  // Without a place to record it (the legacy grid), the pane keeps its thread until unmounted.
  const [kept, setKept] = useState<string | null>(null);
  const threadId = thread.id ?? kept;
  const record = (id: string | null, title?: string) => {
    setKept(id);
    onThreadChange?.({ id, ...(title ? { title } : {}) });
  };
  const current = all.threads.find((t) => t.id === threadId) ?? null;
  const title = current?.title ?? undefined;
  useEffect(() => {
    if (current && title !== thread.title) onThreadChange?.({ id: current.id, ...(title ? { title } : {}) });
  }, [current, title, thread.title, onThreadChange]);

  const rail: ChatRail = {
    ...all,
    activeId: threadId,
    setActiveId: (next: SetStateAction<string | null>) => record(typeof next === "function" ? next(threadId) : next),
  };

  const threadComposers = useThreadComposerRegistry();
  const paneId = cell.id;
  const mode: ChatPaneMode = useMemo(
    () => ({
      cwd: cell.cwd,
      headerSlot,
      focused,
      openFile: workspaceId ? (path, line) => void openFileLinkInWorkspace(workspaceId, { path, ...(line ? { startLine: line } : {}) }) : undefined,
      onRegisterSend: threadComposers ? (send) => threadComposers.register(paneId, send) : undefined,
      // Waiting drafts first (⌘L can open this pane), then each new one.
      onDraft: (take) => {
        const drain = () => {
          const draft = takeThreadDraft(paneId);
          if (draft !== null) take(draft);
        };
        drain();
        return onThreadDraft(paneId, drain);
      },
      onActivity: (working, waiting) => {
        threadActivityRegistry.setStreaming(paneId, working);
        threadActivityRegistry.setWaiting(paneId, waiting);
      },
    }),
    [cell.cwd, headerSlot, focused, paneId, threadComposers, workspaceId],
  );
  useEffect(() => () => threadActivityRegistry.clear(paneId), [paneId]);
  useEffect(() => {
    if (!threadId) return;
    chatPaneThreads.set(paneId, threadId);
    return () => {
      chatPaneThreads.delete(paneId);
    };
  }, [paneId, threadId]);

  if (threadId && !all.loaded) {
    return <div className="flex h-full items-center justify-center text-[11px] text-(--text-muted)">Loading conversation…</div>;
  }

  if (threadId && !current) {
    return (
      <div className="chat-pane-gone">
        <Dither className="chat-pane-gone-glow" field={glow} />
        <p className="chat-pane-gone-title">This chat was deleted</p>
        <p className="chat-pane-gone-body">From Chat mode’s rail. Its folder wasn’t touched.</p>
        <div className="chat-pane-gone-actions">
          {onClose && (
            <button type="button" className="chat-pane-gone-close" onClick={onClose}>
              Close pane
            </button>
          )}
          <button type="button" className="chat-pane-gone-new" onClick={() => record(null)}>
            New chat here
          </button>
        </div>
      </div>
    );
  }

  return <ChatPage rail={rail} pane={mode} />;
}
