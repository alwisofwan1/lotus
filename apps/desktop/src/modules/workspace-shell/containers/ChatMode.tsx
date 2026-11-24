"use client";

import "@/styles/chat.css";

import { useEffect, useState } from "react";
import { agentsLine, displayTitle, placeName, railChildren, railDescendants, railSections, railState, shortSince, sinceLabel } from "@/modules/chat/domain/rail";
import type { ChatThread } from "@/modules/chat/runtime/chat-runtime-client";
import type { ThreadRow } from "@/modules/workspace-shell/components/ThreadRail";
import { markChatThreadRead } from "@/modules/chat/runtime/chat-runtime-client";
import { ChatPage, type ChatRail } from "@/modules/chat/ui/ChatPage";
import { useThreadActions } from "@/modules/chat/ui/ThreadActions";
import { SplitHandle } from "@/modules/workspace-shell/components/SplitHandle";
import { draftPreview, readComposerDraft } from "@/modules/chat/domain/composer-draft";
import { useDraftThreads } from "@/modules/chat/view-model/useDraftThreads";
import { ThreadRail } from "@/modules/workspace-shell/components/ThreadRail";
import { useElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import { railMotionProps, useRailMotion, useRailPresence } from "@/modules/workspace-shell/hooks/useRailPresence";
import { clampSplitSize, computeSplitMax } from "@/modules/workspace-shell/services/split-sizing";
import type { ShellModeStatus } from "@/modules/workspace-shell/types";

const RAIL_DEFAULT = 300;
const RAIL_MIN = 232;
const CONVERSATION_MIN = 380;
/** The seam between rail and conversation — `--ws-seam` in the stylesheet. */
const RAIL_OVERLAY_SEAM = 10;
/** Earlier shows this many rows, then "Show N more". */
const EARLIER_LIMIT = 12;

interface ChatModeProps {
  /** The shell's thread listing (`useChatRail`), shared with the Chat tab's mark and the alerts. */
  rail: ChatRail;
  railVisible: boolean;
  /** On screen with nothing over it: the new chat's shortcuts (⌘R, ⌘P, ⌘⇧B) are live only then. */
  shown?: boolean;
  /** The window's nav rows for this mode's rail — Tasks, today. */
  navSlot?: React.ReactNode;
  /** A section's sidebar content for this mode's rail, in place of its list. See `WorkspaceRail`. */
  sectionSlot?: React.ReactNode;
  /** A panel covering the conversation, never the rail. See `CodeMode` for why that line matters. */
  columnOverlay?: React.ReactNode;
  /** The user asked to see the conversation — picking a thread, or starting one. See `CodeMode`. */
  onRevealWork?: () => void;
  railWidth: number;
  onRailResize: (width: number) => void;
  /** Reported up for the chrome's status pill; see `ShellModeStatus`. */
  onStatusChange?: (status: ShellModeStatus | null) => void;
}

/**
 * Chat mode on the chat module (#289; mockup page "07a New Chat (beta)").
 *
 * The shell's rail, split handle and overlay. The rail lists the chat's threads by folder; the
 * column is `ChatPage` without its own rail.
 */
export function ChatMode({
  rail,
  railVisible,
  shown = true,
  railWidth,
  onRailResize,
  onStatusChange,
  navSlot,
  sectionSlot,
  columnOverlay,
  onRevealWork,
}: ChatModeProps) {
  const { threads, setThreads, activeId, setActiveId, now } = rail;
  const drafted = useDraftThreads();
  // Read when the rail draws, not per keystroke: only whether a draft exists is pushed.
  const draftOf = (threadId: string) => {
    if (!drafted.has(threadId)) return undefined;
    const saved = readComposerDraft(threadId);
    return saved ? draftPreview(saved) : undefined;
  };

  const [bodyRef, body] = useElementSize<HTMLDivElement>();
  const railMax = computeSplitMax(body.width, CONVERSATION_MIN, RAIL_MIN);
  const railSize = clampSplitSize(railWidth ?? RAIL_DEFAULT, { min: RAIL_MIN, max: railMax });
  const railPresence = useRailPresence(railVisible);
  const railSlotRef = useRailMotion(railPresence, railSize + RAIL_OVERLAY_SEAM);

  const threadCount = threads.length;
  useEffect(() => {
    onStatusChange?.({ label: threadCount === 1 ? "1 thread" : `${threadCount} threads`, tone: "thread" });
  }, [onStatusChange, threadCount]);

  // ⌘K finds a thread: it focuses the rail's search field. Chat mode only; Code mode has its own ⌘K.
  useEffect(() => {
    if (!shown || !railVisible) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      const field = document.getElementById("thread-rail-search");
      if (!(field instanceof HTMLInputElement) || field.closest("[hidden], [inert]")) return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, railVisible]);

  const threadActions = useThreadActions(rail);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // The thread opened from Ready keeps its place until another is opened (PLAN: "holds its place").
  const [heldId, setHeldId] = useState<string | null>(null);
  if (heldId !== null && heldId !== activeId) setHeldId(null); // another thread opened, by any path
  const readThread = (threadId: string) => {
    const at = Date.now();
    setThreads((list) => list.map((thread) => (thread.id === threadId ? { ...thread, lastReadAt: at } : thread)));
    markChatThreadRead(threadId).catch(() => {});
  };

  // Watching counts as reading: news on the open thread is read while the window has focus, and
  // when the window gets it back (then held in place, so it does not jump away under you).
  const active = threads.find((thread) => thread.id === activeId) ?? null;
  const activeNews = active !== null && railState(active) === "ready";
  useEffect(() => {
    if (!activeNews || !activeId) return;
    if (document.hasFocus()) {
      readThread(activeId);
      return;
    }
    const onFocus = () => {
      setHeldId(activeId);
      readThread(activeId);
    };
    window.addEventListener("focus", onFocus, { once: true });
    return () => window.removeEventListener("focus", onFocus);
    // readThread is a fresh closure each render; activeNews and activeId are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNews, activeId]);

  const openThread = (threadId: string) => {
    // A sub-agent row: its thread is the open one; watch the sub-agent in its place (D9).
    if (rail.subAgents?.agents.some((agent) => agent.id === threadId)) {
      onRevealWork?.();
      rail.setAgentId?.(threadId);
      return;
    }
    rail.setAgentId?.(null);
    const thread = threads.find((t) => t.id === threadId);
    const news = thread !== undefined && railState(thread) === "ready";
    setHeldId(news ? threadId : null);
    if (news) readThread(threadId);
    onRevealWork?.();
    setActiveId(threadId);
  };

  const archived = threads.filter((thread) => thread.archived);
  const children = railChildren(threads.filter((thread) => !thread.archived));
  // The open thread's own sub-agents (D9), nested by the Agent call that started each one.
  const nativeRows = (threadId: string, under: string | null = null): ThreadRow[] =>
    rail.subAgents?.threadId !== threadId
      ? []
      : rail.subAgents.agents
          .filter((agent) => agent.parentId === under)
          .map((agent) => ({
            id: agent.id,
            title: agent.description ?? agent.type ?? "Sub-agent",
            folder: agent.type ?? "",
            state: agent.status === "running" ? "running" : undefined,
            time: "",
            native: true,
            children: nativeRows(threadId, agent.id),
          }));
  // A delegated chat: its runner's model and effort where a lead shows its folder.
  const childRow = (thread: ChatThread): ThreadRow => {
    const state = railState(thread);
    return {
      id: thread.id,
      title: thread.title ? displayTitle(thread.title) : "Untitled chat",
      fullTitle: thread.title ?? undefined,
      folder: [thread.model ?? thread.runner, thread.effort].filter(Boolean).join(" · "),
      state,
      time: shortSince(thread.lastTurnEndedAt ?? thread.updatedAt, now),
      runningSince: thread.turnStartedAt ?? undefined,
      draft: draftOf(thread.id),
      children: [...nativeRows(thread.id), ...(children.get(thread.id) ?? []).map(childRow)],
    };
  };
  const groups = [
    ...railSections(threads, heldId).map((section) => ({
      id: section.id,
      label: section.label,
      limit: section.id === "earlier" ? EARLIER_LIMIT : undefined,
      threads: section.threads.map(({ thread, state }) => {
        const tree = railDescendants(thread.id, children);
        // The branch opens while you are in it or one of its chats is busy; folded, the lead says "3 agents · done".
        const unfolded = [thread.id, ...tree.map((d) => d.thread.id)].includes(activeId ?? "") || tree.some((d) => ["running", "waiting"].includes(railState(d.thread)));
        const agents = unfolded ? null : agentsLine(thread, children);
        return {
          id: thread.id,
          title: thread.title ? displayTitle(thread.title) : "Untitled chat",
          fullTitle: thread.title ?? undefined,
          folder: agents ? `${placeName(thread)} · ${agents}` : placeName(thread),
          state,
          time: shortSince(state === "ready" ? (thread.lastTurnEndedAt ?? thread.updatedAt) : thread.updatedAt, now),
          runningSince: thread.turnStartedAt ?? undefined,
          draft: draftOf(thread.id),
          children: unfolded ? [...nativeRows(thread.id), ...(children.get(thread.id) ?? []).map(childRow)] : undefined,
        };
      }),
    })),
    // Archived (#291): one drawer at the bottom.
    ...(archived.length
      ? [
          {
            id: "archived",
            label: "Archived",
            drawer: { open: archiveOpen, onToggle: () => setArchiveOpen((open) => !open) },
            threads: archived.map((thread) => ({
              id: thread.id,
              title: thread.title ? displayTitle(thread.title) : "Untitled chat",
              fullTitle: thread.title ?? undefined,
              folder: placeName({ ...thread, link: null }),
              time: sinceLabel(thread.updatedAt, now),
              draft: draftOf(thread.id),
            })),
          },
        ]
      : []),
  ];

  return (
    <div className="ws-body" ref={bodyRef} {...railMotionProps(railPresence, railSize)}>
      <div
        className="ws-pane-slot"
        ref={railSlotRef}
        data-rail={railPresence ?? "hidden"}
        inert={railPresence ? undefined : true}
        aria-hidden={railPresence ? undefined : true}
        style={{ width: railSize }}
      >
        <ThreadRail
          navSlot={navSlot}
          sectionSlot={sectionSlot}
          groups={groups}
          activeThreadId={rail.agentId ?? activeId}
          newChatOpen={activeId === null}
          threadActions={threadActions}
          onSelectThread={openThread}
          onNewThread={() => {
            setHeldId(null);
            onRevealWork?.();
            rail.setAgentId?.(null);
            setActiveId(null);
          }}
        />
      </div>
      {railPresence ? (
        <SplitHandle
          orientation="vertical"
          size={railSize}
          min={RAIL_MIN}
          max={railMax}
          defaultSize={RAIL_DEFAULT}
          label="Resize thread rail"
          onResize={onRailResize}
        />
      ) : null}

      <div className="ws-column" inert={columnOverlay ? true : undefined} aria-hidden={columnOverlay ? true : undefined}>
        <section className="ws-card ws-thread-card" data-kind="thread">
          <ChatPage rail={rail} shown={shown && !columnOverlay} />
        </section>
      </div>

      {columnOverlay ? (
        <div className="ws-column-overlay" style={{ left: railVisible ? railSize + RAIL_OVERLAY_SEAM : 0 }}>
          {columnOverlay}
        </div>
      ) : null}
    </div>
  );
}
