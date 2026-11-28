"use client";

import { Check, ChevronLeft, ChevronRight, Ellipsis, PanelRight, Pin, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";

import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";
import type { BrowserAnnotationPayload } from "@/lib/tauri/browser-preview";

import { changesRefreshKey, fileEdits } from "../domain/changes";
import { absPath, changedInFolder, resolveFile } from "../domain/files";
import { composerStatus, unreadMessages, type SentMessage } from "../domain/composer";
import { clearComposerDraft } from "../domain/composer-draft";
import { pickAgentName } from "../domain/agent-handle";
import { shuffled } from "@/lib/agent-catalog";
import { currentNamePool } from "@/lib/agent-naming";
import { AgentNameControl } from "@/modules/workspace-shell/components/AgentNameControl";
import { addPick, detectedServer, withPicks, type Pick } from "../domain/preview";
import { pruneQuotes, QUOTES_CHANGED, readQuotes, reviewNoteText, withQuotes, writeQuotes, type Quote } from "../domain/quotes";
import { folderName, railGroups, sinceLabel, startOfDay, statsLine, statusLabel } from "../domain/rail";
import { permissionLabel } from "../domain/permissions";
import { latestPlan } from "../domain/plan";
import { waitingRequests } from "../domain/requests";
import type { Attachment } from "../domain/thread-event";
import { threadRuns } from "../domain/runs";
import { buildTimelineRows, lastLine, nativeAgents, subAgentState, type NativeAgent } from "../domain/timeline";
import {
  chatHandoffSeed,
  createChatThread,
  createRemoteChatThread,
  getChatStats,
  interruptChatTurn,
  forkChat,
  forkChatToWorktree,
  rewindChat,
  listChatThreads,
  onChatRailChange,
  resolveChatInteraction,
  sendChatMessage,
  setChatAccount,
  setChatAgentName,
  setChatPermissionMode,
  setChatModel,
  type ChatStats,
  type ChatThread,
} from "../runtime/chat-runtime-client";
import { useChatChanges } from "../view-model/useChatChanges";
import { useChatFiles } from "../view-model/useChatFiles";
import { useChatThread } from "../view-model/useChatThread";
import { useWorkbench } from "../view-model/useWorkbench";
import { clampWorkbenchWidth, type WorkbenchTab } from "../domain/workbench";
import { ChatRemoteNotice } from "./ChatMachines";
import { ChatAccountPicker, ChatLimitBar, nextAccount, useUsageAccounts } from "./ChatAccount";
import { accountLine } from "./ChatAuth";
import { ChangesBar, ChangesPane, ChatDrawer } from "./ChatChanges";
import { ContextPane } from "./ChatContext";
import { pruneComposerDrafts } from "../domain/composer-draft";
import { ChatComposer } from "./ChatComposer";
import { ChatPlan } from "./ChatPlan";
import { FileLinksContext, FilesPane, type FileTarget } from "./ChatFiles";
import { AGENT_NAMES, ChatModelPicker, currentOption, modelName, modelOptions, RunnerMark, useChatModels, type HandoffPick } from "./ChatModel";
import { ChatStage } from "./ChatPreview";
import { usePickCapture } from "./usePickCapture";
import { fixPrompt, RunBadge, RunLinksContext, RunsPane } from "./ChatRuns";
import { TurnActionsContext, type TurnActions } from "./ChatTurnActions";
import { ChatPermissionPicker, ChatStart, draftInFolder, loadDraft, type Draft } from "./ChatStart";
import { chatFontStyle, useChatFont } from "./chat-font";
import { Dither } from "./Dither";
import { ConversationTitle } from "@/modules/conversation-title/ConversationTitle";
import { useThreadActions, type ThreadActions } from "./ThreadActions";
import { ChatTimeline } from "./timeline/ChatTimeline";
import { useAriaKeyShortcuts, useFormatShortcut } from "@/lib/hooks/useShortcutLabel";


function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** A glow rising from the bottom centre, fading out on every edge. */
const horizon = (u: number, v: number) => Math.max(0, 1 - Math.hypot((u - 0.5) * 2.1, (v - 0.78) * 2.6)) ** 1.6;

// The runtime says when a thread moves (`chat://rail-changed`); the poll only catches titles and
// keeps the rail's "12m ago" ticking.
const RAIL_POLL_MS = 15_000;

export interface ChatRail {
  threads: ChatThread[];
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  /** Null: the start screen. */
  activeId: string | null;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  /** The rail's "12m ago", ticking with the poll. */
  now: number;
  error: string | null;
  /** The first listing has arrived: a thread missing from `threads` is gone, not still loading. */
  loaded?: boolean;
  /** The open thread's own sub-agents, for the rail (D9): only that thread's events are loaded. */
  subAgents?: { threadId: string; agents: NativeAgent[] } | null;
  setSubAgents?: Dispatch<SetStateAction<{ threadId: string; agents: NativeAgent[] } | null>>;
  /** The open thread's sub-agent being watched, in place of the thread; null = the thread itself. */
  agentId?: string | null;
  setAgentId?: Dispatch<SetStateAction<string | null>>;
}

/** A Code pane (07d): the conversation alone, born in the workspace's folder. No Workbench
 *  drawer or Preview; a file link opens in the workspace's editor. */
export interface ChatPaneMode {
  cwd: string;
  /** The pane header's own spot: Done is drawn there, since a pane has no `.chat-header`. */
  headerSlot?: HTMLElement | null;
  /** The pane has focus, so ⌘⇧E (Done) is this chat's. */
  focused?: boolean;
  /** An absolute path. */
  openFile?: (path: string, line: number | null) => void;
  /** Offers the pane's send to the shell's command bar; returns the unregister. */
  onRegisterSend?: (send: (text: string) => void) => () => void;
  onActivity?: (working: boolean, waiting: boolean) => void;
  /** ⌘L in an Editor: text put into the composer, unsent. */
  onDraft?: (take: (text: string) => void) => () => void;
}

/** The threads and which one is open. Owned by whoever draws the rail: this page, or the workspace
 *  shell's Chat mode (#289). `enabled` false: no listing, no polling. */
export function useChatRail(enabled = true): ChatRail {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [subAgents, setSubAgents] = useState<{ threadId: string; agents: NativeAgent[] } | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  // Another thread opened, by any path: stop watching the last one's sub-agent.
  const [watchedIn, setWatchedIn] = useState(activeId);
  if (watchedIn !== activeId) {
    setWatchedIn(activeId);
    setAgentId(null);
  }
  useEffect(() => {
    if (!enabled) return;
    // The list is every thread, archived too, so it can say which drafts lost theirs.
    const take = (list: ChatThread[]) => {
      setThreads(list);
      pruneComposerDrafts(list.map((t) => t.id));
      pruneQuotes(list.map((t) => t.id));
    };
    listChatThreads().then(
      (list) => {
        take(list);
        setLoaded(true);
        setActiveId((id) => id ?? list[0]?.id ?? null);
      },
      (reason: unknown) => setError(message(reason)),
    );
    const refresh = () => {
      setNow(Date.now());
      listChatThreads().then(take, () => {});
    };
    const poll = setInterval(refresh, RAIL_POLL_MS);
    const stop = onChatRailChange(refresh);
    return () => {
      clearInterval(poll);
      stop();
    };
  }, [enabled]);
  return { threads, setThreads, activeId, setActiveId, now, error, loaded, subAgents, setSubAgents, agentId, setAgentId };
}

/** The new Chat module, beta (plans/chat-runtime/PLAN.md). With `rail`, the caller draws the
 *  thread list and this page is the conversation only (workspace Chat mode, #289). */
const REMOTE_TABS: readonly WorkbenchTab[] = ["changes", "files"];

export function ChatPage({ rail, shown = true, pane: inPane }: { rail?: ChatRail; shown?: boolean; pane?: ChatPaneMode } = {}) {
  const own = useChatRail(!rail);
  const shortcut = useFormatShortcut();
  const ariaShortcut = useAriaKeyShortcuts();
  const { threads, setThreads, activeId, setActiveId, now, error: listError } = rail ?? own;
  const [error, setError] = useState<string | null>(null);
  const font = useChatFont();
  const actions = useThreadActions(rail ?? own);
  const archived = threads.filter((t) => t.archived);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const view = useChatThread(activeId);
  const setSubAgents = (rail ?? own).setSubAgents;
  const agents = useMemo(() => (view.state ? nativeAgents(view.state) : []), [view.state]);
  // Keyed by content: the state changes on every streamed token, the agents rarely.
  const agentsKey = JSON.stringify(agents);
  useEffect(() => {
    setSubAgents?.(activeId ? { threadId: activeId, agents } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsKey, activeId, setSubAgents]);
  const active = threads.find((t) => t.id === activeId) ?? null;
  // A chat opened without an Agent Handle draws one now (ADR-0068); old chats get theirs here too.
  const naming = useRef(new Set<string>());
  useEffect(() => {
    if (!active || active.archived || active.agentName || naming.current.has(active.id)) return;
    naming.current.add(active.id);
    const name = pickAgentName(threads, active, shuffled(currentNamePool()));
    setThreads((list) => list.map((t) => (t.id === active.id ? { ...t, agentName: name } : t)));
    void setChatAgentName(active.id, name).catch(() => naming.current.delete(active.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.agentName, active?.archived]);
  // A delegated chat leads back to the chat that started it.
  // A fork has a parent too, but says so in its own marker; it was not delegated.
  const lead = active?.parentId && !view.state?.forkedFrom ? (threads.find((t) => t.id === active.parentId) ?? null) : null;
  const status = composerStatus(view.state);
  const waiting = waitingRequests(view.state);
  const planTasks = useMemo(() => latestPlan(view.state), [view.state]);
  // Queued and steered messages per thread, until Claude reads them.
  const [sent, setSent] = useState<Record<string, SentMessage[]>>({});
  const models = useChatModels(active?.runner ?? "claude");
  const { openSettings } = useLotusSettings();
  const api = active?.runner === "api";
  const providerName = api ? (models.models.find((m) => m.provider === active?.provider)?.providerName ?? null) : null;
  const agentName = providerName ?? AGENT_NAMES[active?.runner ?? "claude"];
  const currentModel = view.state?.session.model ?? active?.model ?? null;
  const [usageAccounts, refreshUsage] = useUsageAccounts();
  const claudeAccounts = useMemo(() => usageAccounts.filter((a) => a.provider === "claude"), [usageAccounts]);
  const currentAccount = view.state?.account ?? active?.account ?? claudeAccounts.find((a) => a.inUse)?.account ?? null;
  const limit = active?.runner === "claude" && view.state?.rateLimit?.status === "rejected" ? view.state.rateLimit : null;
  // The Workbench (#281 Changes, #282 Files, #283 Runs, #284 Preview): one panel per thread, kept
  // as each thread left it (plans/chat-right-sidebar, M1); a commit leaves a receipt in the bar.
  const workbench = useWorkbench(activeId);
  const { open: wbOpen, tab: savedPane, wide, width } = workbench.state;
  // A remote chat has Changes and Files only (mockups/chat-remote-machine.html, decision 9).
  const remoteTabs = active?.machine ? REMOTE_TABS : undefined;
  const pane = remoteTabs && !remoteTabs.includes(savedPane) ? "changes" : savedPane;
  const [target, setTarget] = useState<(FileTarget & { threadId: string }) | null>(null);
  const [find, setFind] = useState(0);
  const [runTarget, setRunTarget] = useState<{ threadId: string; id: string; n: number } | null>(null);
  const [diffTarget, setDiffTarget] = useState<{ threadId: string; path: string; n: number } | null>(null);
  // A Review note card asked to be edited: its file opens through diffTarget, the editor through this.
  const [editNote, setEditNote] = useState<{ threadId: string; id: string; n: number } | null>(null);
  // "Continue in …": the next message from this chat starts a new chat in `to` (handoff).
  const [handoff, setHandoff] = useState<(HandoffPick & { fromId: string }) | null>(null);
  const [fill, setFill] = useState<{ threadId: string; text: string; n: number; append?: boolean; attachments?: Attachment[] } | null>(null);
  // Preview (#284): each chat's address, and its picks.
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, Pick[]>>({});
  // Passages quoted from the chat, per chat; they go with the next message as `> ` lines.
  const [quotes, setQuotes] = useState<Record<string, Quote[]>>({});
  // Stored per thread, so a reload keeps a review in progress. Read before anything here writes,
  // so a second surface never overwrites the stored list with its own empty one.
  if (active && !(active.id in quotes)) setQuotes((all) => (active.id in all ? all : { ...all, [active.id]: readQuotes(active.id) }));
  // Write only the lists this surface changed; the other surface hears the event and re-reads.
  const written = useRef<Record<string, Quote[]>>({});
  useEffect(() => {
    for (const [threadId, list] of Object.entries(quotes)) {
      if (written.current[threadId] === list) continue;
      written.current[threadId] = list;
      writeQuotes(threadId, list);
    }
  }, [quotes]);
  useEffect(() => {
    const onChanged = (event: Event) => {
      const threadId = (event as CustomEvent<string>).detail;
      setQuotes((all) => {
        if (!(threadId in all)) return all;
        const stored = readQuotes(threadId);
        return JSON.stringify(stored) === JSON.stringify(all[threadId]) ? all : { ...all, [threadId]: stored };
      });
    };
    window.addEventListener(QUOTES_CHANGED, onChanged);
    return () => window.removeEventListener(QUOTES_CHANGED, onChanged);
  }, []);
  const [receipt, setReceipt] = useState<{ threadId: string; text: string; hint?: string } | null>(null);
  const refreshKey = changesRefreshKey(view.state);
  const changes = useChatChanges(active?.id ?? null, refreshKey);
  const cwd = view.state?.session.cwd ?? active?.cwd ?? null;
  // Only where the drawer exists: a remembered "open" must not leave an empty column in an API chat or a pane.
  const review = active !== null && cwd !== null && !api && !inPane && wbOpen;
  // Context shows limits: read them fresh each time it opens.
  const contextShown = review && pane === "context";
  useEffect(() => {
    if (contextShown) refreshUsage();
  }, [contextShown, refreshUsage]);
  // Bumped by a file made, renamed or trashed in Files, which no turn reports.
  const [filesTick, setFilesTick] = useState(0);
  const folder = useChatFiles(cwd, `${refreshKey}#${filesTick}`, active?.machine);
  const changed = useMemo(
    () => changedInFolder(changes.changes?.files.map((f) => f.path) ?? [], changes.changes?.prefix ?? ""),
    [changes.changes],
  );
  // Memoized by the React Compiler; a manual useMemo can't be kept once `threads` may come from props.
  const links =
    active && cwd
      ? {
          cwd,
          resolve: (path: string) => resolveFile(folder.set, path, cwd),
          // A web page or an HTML file opens in Preview beside the chat (not inside another pane).
          browse: inPane || api
            ? undefined
            : (url: string) => {
                workbench.show("preview");
                setUrls((u) => ({ ...u, [active.id]: url }));
              },
          open: ({ path, line }: { path: string; line: number | null }) => {
            if (inPane) return inPane.openFile?.(absPath(cwd, path), line);
            setTarget((t) => ({ threadId: active.id, path, line, n: (t?.n ?? 0) + 1 }));
            workbench.show("files");
          },
          // Changes lists repository paths; the timeline speaks folder-relative ones.
          review: inPane || api
            ? undefined
            : (path: string) => {
                setDiffTarget((t) => ({ threadId: active.id, path: `${changes.changes?.prefix ?? ""}${path}`, n: (t?.n ?? 0) + 1 }));
                workbench.show("changes");
              },
          changed,
        }
      : null;
  const runs = useMemo(() => threadRuns(view.state), [view.state]);
  const openRun = active && !inPane
    ? (id: string) => {
        setRunTarget((t) => ({ threadId: active.id, id, n: (t?.n ?? 0) + 1 }));
        workbench.show("runs");
      }
    : null;
  const turnActions: TurnActions | null = active
    ? {
        quote: (text) =>
          setQuotes((all) => {
            const list = all[active.id] ?? [];
            // The same passage twice is one card.
            if (list.some((q) => q.text === text)) return all;
            return { ...all, [active.id]: [...list, { id: crypto.randomUUID(), text, at: Date.now() }] };
          }),
        fork: async (turnId) => {
          const thread = await forkChat(active.id, turnId);
          setThreads((list) => [thread, ...list]);
          setActiveId(thread.id);
        },
        // Runners whose session can branch at a turn, as Fork does (chat_runtime::rewind).
        branches: ["claude", "codex", "api"].includes(active.runner),
        edit: async (turnId, text) => {
              setError(null);
              await rewindChat(active.id, turnId);
              const clientRequestId = crypto.randomUUID();
              const track = (update: (list: SentMessage[]) => SentMessage[]) =>
                setSent((all) => ({ ...all, [active.id]: update(all[active.id] ?? []) }));
              track((list) => [...list, { clientRequestId, text, mode: "send", attachments: [] }]);
              try {
                await sendChatMessage(active.id, text, clientRequestId, []);
              } catch (reason) {
                // The chat already went back, so the editor is gone: the words wait in the composer.
                track((list) => list.filter((m) => m.clientRequestId !== clientRequestId));
                setError(message(reason));
                setFill((f) => ({ threadId: active.id, text, n: (f?.n ?? 0) + 1, attachments: [] }));
              }
            },
        open: setActiveId,
        toWorktree: async () => {
          const moved = await forkChatToWorktree(active.id);
          setThreads((list) => list.map((t) => (t.id === moved.id ? moved : t)));
        },
        billed: accountLine(active.runner, view.state?.session.authSource ?? "unknown", view.state?.session.requestedAuth ?? null)?.label === "API key",
      }
    : null;
  const main = useRef<HTMLElement>(null);
  const centre = useRef<number | null>(null);
  const reviewOpen = review;
  const staged = review && pane === "preview";
  const detected = useMemo(() => detectedServer(view.state), [view.state]);
  const toggleStage = () => {
    if (!active) return;
    if (staged) return workbench.patch({ open: false });
    workbench.show("preview");
    if (!urls[active.id] && detected) setUrls((u) => ({ ...u, [active.id]: detected.url }));
  };
  const toggleWorkbench = () => workbench.patch({ open: !wbOpen });
  const toggleRef = useRef(toggleStage);
  const workbenchRef = useRef({ toggle: toggleWorkbench, wb: workbench, open: wbOpen, wide });
  const doneRef = useRef(() => {});
  useEffect(() => {
    toggleRef.current = toggleStage;
    workbenchRef.current = { toggle: toggleWorkbench, wb: workbench, open: wbOpen, wide };
  });
  const capture = usePickCapture({
    onPick: ({ saveTo: threadId }, picked) => setPicks((all) => ({ ...all, [threadId]: addPick(all[threadId] ?? [], picked) })),
    onNote: ({ saveTo: threadId }, note) => setFill((f) => ({ threadId, text: note, n: (f?.n ?? 0) + 1, append: true })),
  });
  const pick = (threadId: string, payload: BrowserAnnotationPayload) =>
    capture({ slot: threadId, saveTo: threadId }, payload).catch((reason) => setError(message(reason)));
  // FLIP: the column changes in one step, so the chat starts where it was and glides to its new
  // centre with a transform, in time with the drawer's slide.
  useLayoutEffect(() => {
    const el = main.current;
    if (!el) return;
    const now = el.getBoundingClientRect();
    const mid = now.left + now.width / 2;
    const from = centre.current;
    centre.current = mid;
    if (from === null || from === mid || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const child of el.querySelectorAll(":scope > :not(.chat-header)")) {
      child.animate?.([{ transform: `translateX(${from - mid}px)` }, { transform: "none" }], {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
    }
  }, [reviewOpen, wide]);
  // Wide: the chat folds to its composer, floating under the Workbench. The Workbench ends above
  // it, measured, since the Preview page is a native view drawn over anything placed on it.
  useEffect(() => {
    const el = main.current;
    const page = el?.parentElement;
    if (!el || !page || !(reviewOpen && wide)) return;
    const observer = new ResizeObserver(() => page.style.setProperty("--chat-dock-h", `${el.offsetHeight}px`));
    observer.observe(el);
    return () => {
      observer.disconnect();
      page.style.removeProperty("--chat-dock-h");
    };
  }, [reviewOpen, wide]);
  // A window resize moves the centre too; without this the next toggle would glide from a stale spot.
  useEffect(() => {
    const track = () => {
      const r = main.current?.getBoundingClientRect();
      if (r) centre.current = r.left + r.width / 2;
    };
    window.addEventListener("resize", track);
    return () => window.removeEventListener("resize", track);
  }, []);

  useEffect(() => {
    // Parked behind another workspace mode, the shortcuts belong to that mode.
    if (!active || !shown || inPane) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleRef.current();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        doneRef.current();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key === "Enter") {
        // Only while the drawer is open: the composer's own Enter keys stay its own otherwise.
        const { wb, open, wide: isWide } = workbenchRef.current;
        if (!open) return;
        event.preventDefault();
        wb.patch({ wide: !isWide });
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "r") {
        event.preventDefault(); // ⌘R would reload the webview.
        workbenchRef.current.toggle();
      } else if (key === "p") {
        event.preventDefault(); // ⌘P would print.
        setFind((n) => n + 1);
        workbenchRef.current.wb.show("files");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, shown, inPane]);

  // A pane takes only Done (⌘⇧E), and only while it has focus: the page's other keys belong to the shell.
  const paneFocused = !!inPane?.focused;
  useEffect(() => {
    if (!active || !shown || !paneFocused) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        doneRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, shown, paneFocused]);

  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(() => setReceipt(null), 4000);
    return () => clearTimeout(timer);
  }, [receipt]);

  const [stats, setStats] = useState<ChatStats | null>(null);
  useEffect(() => {
    if (activeId !== null) return;
    getChatStats(startOfDay(Date.now())).then(setStats, () => setStats(null));
  }, [activeId]);

  const start = async (draft: Draft, text: string, attachments: Attachment[] = [], id?: string) => {
    // An API chat touches no files; it sits in the home folder.
    const thread = draft.machine && (draft.runner === "claude" || draft.runner === "codex")
      ? await createRemoteChatThread({ ...draft, runner: draft.runner, machine: draft.machine, id })
      : await createChatThread({ ...draft, ...(draft.runner === "api" ? { cwd: "" } : {}), id });
    const clientRequestId = crypto.randomUUID();
    // Shown before the agent starts (seconds with SessionStart hooks), so no empty start screen between.
    setSent((all) => ({ ...all, [thread.id]: [{ clientRequestId, text, mode: "send", attachments }] }));
    setThreads((list) => [thread, ...list]);
    setError(null);
    setActiveId(thread.id);
    try {
      await sendChatMessage(thread.id, text, clientRequestId, attachments);
    } catch (reason) {
      // The chat exists; hand the words and files to its composer to send again.
      setSent((all) => ({ ...all, [thread.id]: [] }));
      setError(message(reason));
      setFill((f) => ({ threadId: thread.id, text, n: (f?.n ?? 0) + 1, attachments }));
    }
  };

  const send = async (active: ChatThread, typed: string, typedAttachments: Attachment[]) => {
    setError(null);
    const clientRequestId = crypto.randomUUID();
    const threadId = active.id;
    const picked = picks[threadId] ?? [];
    const quoted = quotes[threadId] ?? [];
    const text = withPicks(withQuotes(typed, quoted), picked);
    const attachments = [...typedAttachments, ...picked.flatMap((p) => p.attachments)];
    const mode = status.mode;
    const track = (update: (list: SentMessage[]) => SentMessage[]) =>
      setSent((all) => ({ ...all, [threadId]: update(all[threadId] ?? []) }));
    // Tracked before the call: the echo can arrive before the send resolves. A "send" shows in the
    // timeline as the echo will (full text, files); a queue or steer shows in the composer's tray.
    const shown = typed || quoted.map((q) => q.text).join(" · ") || picked.map((p) => p.tag).join(", ") || attachments.map((a) => a.name).join(", ");
    track((list) => [...list, mode === "send" ? { clientRequestId, text, mode, attachments } : { clientRequestId, text: shown, mode }]);
    try {
      await sendChatMessage(threadId, text, clientRequestId, attachments);
      if (picked.length > 0) setPicks((all) => ({ ...all, [threadId]: [] }));
      if (quoted.length > 0) setQuotes((all) => ({ ...all, [threadId]: [] }));
    } catch (reason) {
      track((list) => list.filter((m) => m.clientRequestId !== clientRequestId));
      setError(message(reason));
      throw reason;
    }
  };

  // The new chat gets a seed (the last turn and how to read the rest) before the typed words.
  const continueIn = async (from: ChatThread, to: HandoffPick, typed: string, attachments: Attachment[]) => {
    setError(null);
    const seed = await chatHandoffSeed(from.id, to.runner);
    const draft: Draft = { runner: to.runner, model: to.model, provider: to.provider ?? null, effort: to.effort ?? null, cwd: from.cwd, permissionMode: from.permissionMode };
    await start(draft, `${seed}\n\n${typed}`, attachments);
    setHandoff(null);
  };

  // The shell's command bar (07d) sends through the same path; on the start screen it starts the
  // chat with the last picks, in the pane's folder.
  const fromBar = useRef<(text: string) => void>(() => {});
  useEffect(() => {
    fromBar.current = (text) => {
      const report = (reason: unknown) => setError(message(reason));
      if (active) send(active, text, []).catch(() => {});
      else if (inPane) start(draftInFolder(loadDraft(), inPane.cwd), text).catch(report);
    };
  });
  const registerSend = inPane?.onRegisterSend;
  useEffect(() => registerSend?.((text) => fromBar.current(text)), [registerSend]);
  const working = status.mode !== "send";
  const isWaiting = waiting.length > 0;
  const [startFill, setStartFill] = useState<{ text: string; n: number } | null>(null);
  // A fill is used once; see ChatComposer's `onFilled`.
  const dropFill = useCallback(() => setFill(null), [setFill]);
  const dropStartFill = useCallback(() => setStartFill(null), [setStartFill]);
  const fillDraft = useRef<(text: string) => void>(() => {});
  useEffect(() => {
    fillDraft.current = (text) => {
      if (active) setFill((f) => ({ threadId: active.id, text, n: (f?.n ?? 0) + 1, append: true }));
      else setStartFill((f) => ({ text, n: (f?.n ?? 0) + 1 }));
    };
  });
  const onDraft = inPane?.onDraft;
  useEffect(() => onDraft?.((text) => fillDraft.current(text)), [onDraft]);
  const onActivity = inPane?.onActivity;
  useEffect(() => onActivity?.(working, isWaiting), [onActivity, working, isWaiting]);

  const report = (action: Promise<void>) => action.catch((reason: unknown) => setError(message(reason)));
  // Done (plans/chat-thread-done): deletes the thread, like the rail's Delete. The first press only
  // arms it for 3s, so one stray ⌘⇧E never deletes a chat.
  const [arming, setArming] = useState<string | null>(null);
  useEffect(() => {
    if (!arming) return;
    const timer = setTimeout(() => setArming(null), 3000);
    return () => clearTimeout(timer);
  }, [arming]);
  const armed = !!active && arming === active.id;
  // A pane stays where it is after Done and becomes a new chat in its folder
  // (mockups/chat-pane-done.html, option A); this says what happened, for a few seconds.
  const [deletedNote, setDeletedNote] = useState(false);
  useEffect(() => {
    if (!deletedNote) return;
    const timer = setTimeout(() => setDeletedNote(false), 4000);
    return () => clearTimeout(timer);
  }, [deletedNote]);
  const done = () => {
    if (!active || working) return;
    if (!armed) return setArming(active.id);
    setArming(null);
    void report(actions.remove(active.id).then(() => setDeletedNote(!!inPane)));
  };
  useEffect(() => {
    doneRef.current = done;
  });

  const unread = active ? unreadMessages(sent[active.id] ?? [], view.state) : [];
  const queued = unread.flatMap((m) => (m.mode === "send" ? [] : [{ ...m, mode: m.mode }]));
  const echoing = unread.filter((m) => m.mode === "send");
  const { agentId = null, setAgentId } = rail ?? own;
  const watched = useMemo(() => (agentId && view.state ? subAgentState(view.state, agentId) : null), [agentId, view.state]);
  const watchedAgent = watched ? agents.find((a) => a.id === agentId) : undefined;
  const rows = watched
    ? buildTimelineRows(watched)
    : echoing.length === 0
      ? view.rows
      : [
          ...view.rows,
          ...echoing.map((m) => ({ kind: "user" as const, id: `sent:${m.clientRequestId}`, turnId: "", text: m.text, clientRequestId: m.clientRequestId, attachments: m.attachments ?? [] })),
        ];

  // Hidden while the agent works: deleting a running chat is never one stray press away.
  const doneButton = active && rows.length > 0 && !working && (
    <button
      type="button"
      className={inPane ? "ws-chrome-button ws-pane-action chat-pane-done" : "chat-header-icon"}
      data-quiet={inPane && !armed ? "true" : undefined}
      data-armed={armed || undefined}
      aria-label={armed ? "Delete chat?" : "Done"}
      onClick={done}
      title={armed ? "Press again to delete this chat. Its folder is not touched." : `Done · delete this chat (${shortcut("⌘⇧E")})`}
    >
      {armed ? "Delete chat?" : <Check size={inPane ? 13 : 15} strokeWidth={inPane ? 1.75 : 2} aria-hidden />}
    </button>
  );
  return (
    <div
      className="chat-page"
      data-font={font}
      data-embedded={rail ? "" : undefined}
      data-pane={inPane ? "" : undefined}
      data-review={reviewOpen ? "" : undefined}
      data-wide={reviewOpen && wide ? "" : undefined}
      style={{ ...chatFontStyle(font), ...(reviewOpen && !wide && width ? { "--chat-review-w": `${width}px` } : {}) }}
    >
      {!rail && <aside className="chat-rail" aria-label="Chats">
        <button
          type="button"
          className="chat-rail-new"
          aria-current={activeId === null ? "page" : undefined}
          onClick={() => {
            setError(null);
            setActiveId(null);
          }}
        >
          <Plus size={14} aria-hidden />
          New chat
        </button>
        <nav className="chat-rail-list">
          {railGroups(threads).map((group) => (
            <section key={group.label + group.cwd} aria-label={group.label}>
              <h3 className="chat-rail-group" title={group.cwd}>
                {group.label}
              </h3>
              <ul>
                {group.threads.map((thread) => (
                  <li key={thread.id}>
                    <RailRow thread={thread} active={thread.id === activeId} sub={statusLabel(thread) ?? sinceLabel(thread.updatedAt, now)} actions={actions} onOpen={setActiveId} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {archived.length > 0 && (
            <section aria-label="Archived">
              <button type="button" className="chat-rail-archived" aria-expanded={archiveOpen} onClick={() => setArchiveOpen((o) => !o)}>
                <ChevronRight size={12} aria-hidden />
                Archived
                <span className="chat-rail-count">{archived.length}</span>
              </button>
              {archiveOpen && (
                <ul>
                  {archived.map((thread) => (
                    <li key={thread.id}>
                      <RailRow thread={thread} active={thread.id === activeId} sub={folderName(thread.cwd)} actions={actions} onOpen={setActiveId} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </nav>
        {actions.layer}
      </aside>}
      <main ref={main} className="chat-main">
        {active ? (
          <>
            {/* A pane's own header already names the chat (07d); it carries Done instead. */}
            {inPane?.headerSlot && doneButton && createPortal(doneButton, inPane.headerSlot)}
            {!inPane && <header className="chat-header">
              {/* Folder · thread title (mockups/chat-header-refine.html, option B); the full path is the tooltip. */}
              <span className="chat-header-crumb" title={active.cwd}>
                {active.agentName && (
                  <>
                    {/* Name · folder · title (mockups/agent-naming.html, 3B); the menu's "Rename agent…" reopens it. */}
                    <AgentNameControl
                      key={`${active.id}:${actions.agentEditing?.id === active.id ? actions.agentEditing.n : 0}`}
                      name={active.agentName}
                      startEditing={actions.agentEditing?.id === active.id}
                      onRename={(name) => actions.renameAgent(active.id, name)}
                    />
                    <span className="chat-header-sep" aria-hidden>
                      ·
                    </span>
                  </>
                )}
                {/* A chat moved into a Lotus worktree (a fork, a delegated child) names its original's project, not the worktree's folder. */}
                <span className="chat-header-folder">
                  {folderName((active.cwd.includes("/chat-worktrees/") && threads.find((t) => t.id === active.parentId)?.cwd) || active.cwd)}
                </span>
                {active.title && (
                  <>
                    <span className="chat-header-sep" aria-hidden>
                      ·
                    </span>
                    {/* Keyed so switching threads drops a half-typed name. */}
                    <ConversationTitle
                      key={active.id}
                      className="chat-header-title"
                      title={active.title}
                      readOnly={active.archived}
                      generating={actions.regenerating.has(active.id)}
                      onRename={(title) => actions.rename(active.id, title)}
                      onRegenerate={active.runner === "api" ? undefined : async () => actions.regenerate(active.id)}
                    />
                  </>
                )}
              </span>
              <span className="chat-header-end">
                {api && <span className="chat-header-note">{agentName} · text only</span>}
                {!active.archived && (
                  <button
                    type="button"
                    className="chat-header-icon"
                    aria-pressed={!!active.pinnedAt}
                    aria-label={active.pinnedAt ? "Unpin" : "Pin"}
                    onClick={() => actions.togglePin(active.id)}
                    title={active.pinnedAt ? "Unpin from the top of the rail" : "Pin to the top of the rail, to follow up later"}
                  >
                    <Pin size={15} strokeWidth={2} aria-hidden />
                  </button>
                )}
                {doneButton}
                {!api && <span className="chat-header-rule" aria-hidden />}
                {!api && (
                  <button
                    type="button"
                    className="chat-panel-toggle"
                    aria-pressed={review}
                    aria-label={review ? "Close workbench" : "Open workbench"}
                    aria-keyshortcuts={ariaShortcut("⌘R")}
                    title={review ? `Close workbench · ${shortcut("⌘R")}` : `Workbench · ${shortcut("⌘R")}`}
                    onClick={toggleWorkbench}
                  >
                    <PanelRight size={15} strokeWidth={2} aria-hidden />
                  </button>
                )}
              </span>
            </header>}
            {view.state && rows.length === 0 ? (
              <div className="chat-start">
                <Dither className="chat-start-horizon" field={horizon} />
                <p className="chat-start-title">{api ? "What would you like to ask?" : `What should ${agentName} work on?`}</p>
                <p className="chat-start-meta">
                  {[api ? "Text only" : `In ${active.cwd}`, modelName(models.models, currentModel)].filter(Boolean).join(" · ")}
                </p>
              </div>
            ) : (
              <FileLinksContext.Provider value={links}>
                <RunLinksContext.Provider value={openRun}>
                <TurnActionsContext.Provider value={watched ? null : turnActions}>
                  {watched ? (
                    <div className="chat-watch" role="status">
                      <button type="button" className="chat-watch-back" onClick={() => setAgentId?.(null)}>
                        <ChevronLeft size={14} strokeWidth={2} aria-hidden />
                        {active.title ?? "Back to the chat"}
                      </button>
                      <span className="chat-watch-what">
                        Sub-agent{watchedAgent?.type ? ` · ${watchedAgent.type}` : ""} · read-only
                      </span>
                    </div>
                  ) : lead ? (
                    <div className="chat-watch" role="status">
                      <button type="button" className="chat-watch-back" onClick={() => setActiveId(lead.id)}>
                        <ChevronLeft size={14} strokeWidth={2} aria-hidden />
                        {lead.title ?? "Back to the lead"}
                      </button>
                      <span className="chat-watch-what">Delegated{active.model ? ` · ${active.model}` : ""}</span>
                    </div>
                  ) : null}
                  <ChatTimeline
                    key={watched ? `${active.id}:${agentId}` : active.id}
                    rows={rows}
                    working={watched ? (watched.turns[0].status === "running" ? "Working" : null) : waiting.length > 0 ? null : (status.activity ?? (echoing.length > 0 ? "Starting" : null))}
                  />
                </TurnActionsContext.Provider>
                </RunLinksContext.Provider>
              </FileLinksContext.Provider>
            )}
            {(error ?? listError ?? view.error) && (
              <p className="chat-error" role="alert">
                {error ?? listError ?? view.error}
              </p>
            )}
            {!api && !inPane && <ChangesBar
              changes={changes.changes}
              agentName={agentName}
              touched={fileEdits(view.state) > 0}
              receipt={receipt?.threadId === active.id ? receipt.text : null}
              receiptHint={receipt?.hint}
              open={review}
              onToggle={() => {
                if (review && pane === "changes") workbench.patch({ open: false });
                else workbench.show("changes");
              }}
              run={runs[0] && <RunBadge run={runs[0]} onOpen={() => openRun?.(runs[0].id)} />}
            />}
            {active.importedFrom && !active.providerSessionId && (
              <p className="chat-imported" role="note">
                Imported from CodeChat. The agent starts fresh here and won’t remember this conversation.
              </p>
            )}
            {handoff?.fromId === active.id && (
              <div className="chat-handoff-bar" role="status">
                <RunnerMark runner={handoff.runner} />
                <span className="chat-handoff-bar-text">
                  Handoff to <strong>{AGENT_NAMES[handoff.runner]} · {handoff.label}</strong>
                  <span className="chat-handoff-bar-hint">Next message starts a new chat with this one as context</span>
                </span>
                <button type="button" className="chat-model-icon-btn" aria-label="Exit handoff" title="Exit handoff" onClick={() => setHandoff(null)}>
                  <X size={14} aria-hidden />
                </button>
              </div>
            )}
            {limit && (
              <ChatLimitBar
                current={currentAccount}
                resetsAtMs={limit.resetsAtMs}
                next={nextAccount(claudeAccounts, currentAccount)}
                onContinue={(account) => void report(setChatAccount(active.id, account))}
              />
            )}
            {reviewOpen && wide && (
              <button type="button" className="chat-wide-last" title={`Show the chat · ${shortcut("⇧⌘↩")}`} onClick={() => workbench.patch({ wide: false })}>
                <span className="chat-wide-last-text">{status.activity ? `${agentName} · ${status.activity}` : lastLine(rows)}</span>
                <span className="chat-wide-last-show">Show chat</span>
              </button>
            )}
            {active.machine && <ChatRemoteNotice key={`${active.id}:${active.link ?? "ok"}`} thread={active} onError={(reason) => setError(message(reason))} />}
            {/* A sub-agent is watched, not talked to: no composer while one is open. */}
            {!watched && <ChatComposer
              offline={active.link === "down"}
              remote={Boolean(active.machine)}
              key={`composer:${active.id}`}
              threadId={active.id}
              voiceLive={shown && !inPane}
              runner={active.runner}
              folder={folder}
              changed={changed}
              chats={threads}
              status={status}
              unread={queued}
              model={
                <>
                <ChatModelPicker
                  models={models.models}
                  error={models.error}
                  current={currentModel}
                  effort={view.state?.session.effort ?? active.effort}
                  runner={active.runner}
                  provider={active.provider}
                  account={accountLine(active.runner, view.state?.session.authSource ?? "unknown", view.state?.session.requestedAuth ?? null)}
                  onManage={() => openSettings({ section: "accounts" })}
                  onHandoff={(pick) => setHandoff({ ...pick, fromId: active.id })}
                  onPick={async (model, label, effort) => {
                    setError(null);
                    await report(setChatModel(active.id, model, label, effort));
                  }}
                />
                {active.runner === "claude" && (
                  <ChatAccountPicker
                    accounts={claudeAccounts}
                    current={currentAccount}
                    disabled={status.mode !== "send"}
                    onPick={(account) => report(setChatAccount(active.id, account))}
                    onOpen={refreshUsage}
                  />
                )}
                {!api && (
                  <ChatPermissionPicker
                    current={active.permissionMode}
                    disabled={status.mode !== "send"}
                    onPick={(mode, label) =>
                      report(
                        setChatPermissionMode(active.id, mode, label).then(() =>
                          setThreads((list) => list.map((t) => (t.id === active.id ? { ...t, permissionMode: mode } : t))),
                        ),
                      )
                    }
                  />
                )}
                </>
              }
              details={api ? ["Text only · can’t read or change files"] : []}
              picks={picks[active.id]}
              onRemovePick={(id) => setPicks((all) => ({ ...all, [active.id]: (all[active.id] ?? []).filter((p) => p.id !== id) }))}
              quotes={quotes[active.id]}
              onRemoveQuote={(id) => setQuotes((all) => ({ ...all, [active.id]: (all[active.id] ?? []).filter((q) => q.id !== id) }))}
              onEditQuote={!cwd || api || inPane ? undefined : (id) => {
                const path = quotes[active.id]?.find((q) => q.id === id)?.review?.path;
                if (!path) return;
                setDiffTarget((t) => ({ threadId: active.id, path, n: (t?.n ?? 0) + 1 }));
                setEditNote((e) => ({ threadId: active.id, id, n: (e?.n ?? 0) + 1 }));
                workbench.show("changes");
              }}
              onSend={(typed, typedAttachments) =>
                handoff?.fromId === active.id
                  ? continueIn(active, handoff, typed, typedAttachments).catch((reason) => {
                      setError(message(reason));
                      throw reason;
                    })
                  : send(active, typed, typedAttachments)
              }
              onStop={() => void report(interruptChatTurn(active.id))}
              plan={planTasks && <ChatPlan tasks={planTasks} />}
              agentName={agentName}
              waiting={waiting}
              cwd={view.state?.session.cwd ?? active.cwd}
              fill={fill?.threadId === active.id ? fill : null}
              onFilled={dropFill}
              onDecide={async (interactionId, decision) => {
                setError(null);
                try {
                  await resolveChatInteraction(active.id, interactionId, decision);
                } catch (reason) {
                  setError(message(reason));
                  throw reason;
                }
              }}
            />}
          </>
        ) : (
          <>
          {deletedNote && <p className="chat-pane-deleted" role="status">Chat deleted · its folder was not touched</p>}
          <ChatStart recent={[...new Set(threads.filter((t) => !t.machine).map((t) => t.cwd))]} stats={statsLine(stats)} onStart={start} cwd={inPane?.cwd} fill={startFill} onFilled={dropStartFill} chats={threads} voiceLive={shown && !inPane} />
          </>
        )}
      </main>
      {active && cwd && !api && !inPane && (
        <ChatDrawer
          key={active.id}
          open={review}
          pane={pane}
          onPane={workbench.show}
          counts={{ changes: changes.changes?.files.length ?? 0, runs: runs.length }}
          tabs={remoteTabs}
          onClose={() => workbench.patch({ open: false })}
          wide={wide}
          onWide={() => workbench.patch({ wide: !wide })}
          onResize={(px, room) => workbench.patch({ width: clampWorkbenchWidth(px, room), wide: false })}
          onResetWidth={() => workbench.patch({ width: null, wide: false })}
          changes={
            <ChangesPane
              shown={review && pane === "changes"}
              threadId={active.id}
              remoteHost={active.machine?.host ?? null}
              onOpenFile={(path) => {
                setTarget((t) => ({ threadId: active.id, path, line: null, n: (t?.n ?? 0) + 1 }));
                workbench.show("files");
              }}
              changes={changes.changes}
              agentName={agentName}
              onChanged={changes.reload}
              target={diffTarget?.threadId === active.id ? diffTarget : null}
              onMention={(text) => setFill((f) => ({ threadId: active.id, text, n: (f?.n ?? 0) + 1, append: true }))}
              reviewNotes={quotes[active.id]}
              editNote={editNote?.threadId === active.id ? editNote : null}
              onReviewNote={(change) =>
                setQuotes((all) => {
                  const list = all[active.id] ?? [];
                  const next =
                    change.kind === "add"
                      ? [...list, { id: crypto.randomUUID(), text: reviewNoteText(change.note), at: Date.now(), review: change.note }]
                      : change.kind === "remove"
                        ? list.filter((q) => q.id !== change.id)
                        : list.map((q) => (q.id === change.id && q.review ? { ...q, text: reviewNoteText({ ...q.review, note: change.note }), review: { ...q.review, note: change.note } } : q));
                  return { ...all, [active.id]: next };
                })
              }
              working={working}
              onDiscarded={(text) => {
                const leadId = active.parentId ?? null;
                clearComposerDraft(active.id);
                setThreads((list) => list.filter((t) => t.id !== active.id));
                setActiveId(leadId);
                if (leadId) setReceipt({ threadId: leadId, text, hint: "" });
              }}
              onCommitted={(sha, count) => {
                workbench.patch({ open: false });
                setReceipt({ threadId: active.id, text: `Committed ${sha} · ${count} ${count === 1 ? "file" : "files"} on ${changes.changes?.branch}` });
              }}
            />
          }
          files={
            <FilesPane
              shown={review && pane === "files"}
              cwd={cwd}
              folder={folder}
              changed={changed}
              target={target?.threadId === active.id ? target : null}
              find={find}
              version={refreshKey}
              agentName={agentName}
              onMention={(text) => setFill((f) => ({ threadId: active.id, text, n: (f?.n ?? 0) + 1, append: true }))}
              onFilesChanged={() => setFilesTick((n) => n + 1)}
              remote={active.machine ? { host: active.machine.host, user: active.machine.user, port: active.machine.port } : null}
            />
          }
          runs={
            <RunsPane
              runs={runs}
              target={runTarget?.threadId === active.id ? runTarget : null}
              agentName={agentName}
              // Appended: a half-typed draft is the user's, a fix must not replace it.
              onFix={(run) => setFill((f) => ({ threadId: active.id, text: fixPrompt(run), n: (f?.n ?? 0) + 1, append: true }))}
            />
          }
          context={
            review &&
            pane === "context" && (
              <ContextPane
                state={view.state}
                cwd={cwd}
                branch={changes.changes?.branch ?? null}
                model={currentModel}
                modelLabel={modelName(models.models, currentModel)}
                // The composer shows the model's default effort when none was picked; say the same here.
                effort={view.state?.session.effort ?? active.effort ?? currentOption(modelOptions(models.models), currentModel, active.provider)?.model.defaultEffort ?? null}
                login={accountLine(active.runner, view.state?.session.authSource ?? "unknown", view.state?.session.requestedAuth ?? null)?.label ?? null}
                permission={permissionLabel(active.permissionMode)}
                account={
                  active.runner === "claude"
                    ? (claudeAccounts.find((a) => a.account === currentAccount) ?? null)
                    : active.runner === "codex"
                      ? (usageAccounts.find((a) => a.provider === "codex") ?? null)
                      : null
                }
                accountName={active.runner === "claude" ? currentAccount : null}
                plan={planTasks}
              />
            )
          }
          preview={
            // Mounted only while shown: unmounting hides the native browser and keeps it loaded.
            staged && (
              <ChatStage
                key={`stage:${active.id}`}
                threadId={active.id}
                url={urls[active.id] ?? null}
                // The chat's own folder, not the session's: that follows the agent's `cd` into a subfolder.
                root={active.cwd ?? cwd ?? undefined}
                detected={detected}
                onNavigate={(url) => setUrls((u) => ({ ...u, [active.id]: url }))}
                onPick={(payload) => void pick(active.id, payload)}
              />
            )
          }
        />
      )}
    </div>
  );
}

/** One thread in the /chat rail: the row, its ••• menu button, or the rename field in its place (#291). */
function RailRow({
  thread,
  active,
  sub,
  actions,
  onOpen,
}: {
  thread: ChatThread;
  active: boolean;
  sub: string;
  actions: ThreadActions;
  onOpen: (id: string) => void;
}) {
  if (actions.renaming === thread.id) return actions.renameField(thread.id);
  return (
    <div className="chat-rail-item" data-thread-row="" data-menu-open={actions.menuOpenFor === thread.id ? "" : undefined}>
      <button
        type="button"
        className="chat-rail-row"
        aria-current={active ? "page" : undefined}
        title={thread.title ?? thread.cwd}
        onClick={() => onOpen(thread.id)}
        {...actions.rowProps(thread.id)}
      >
        <RunnerMark runner={thread.runner} />
        <span className="chat-rail-text">
          <span className="chat-rail-title">{thread.title ?? folderName(thread.cwd)}</span>
          <span className="chat-rail-sub" data-status={thread.status ?? undefined}>
            {sub}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="chat-rail-more"
        aria-label="Thread actions"
        aria-haspopup="menu"
        aria-expanded={actions.menuOpenFor === thread.id}
        onClick={(event) => actions.openMenu(thread.id, event.currentTarget)}
      >
        <Ellipsis size={14} aria-hidden />
      </button>
    </div>
  );
}
