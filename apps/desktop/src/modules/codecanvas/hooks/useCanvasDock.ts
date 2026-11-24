"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  clearOpenAskRequest,
  createTauriAutomationClient,
  openAskRequest,
  requestOpenAsk,
  subscribeToOpenAskRequest,
  type OpenAskRequest,
  subscribeToAutomationChanges,
  usePendingDrafts,
  type AutomationClient,
  type Subscribe,
} from "@/modules/automation";
import {
  factoryWorkflowId,
  groupFactoryRuns,
  needsYouCount,
  useSharedFactoryRuns,
  type FactoryRef,
  type FactoryRunsHandle,
  type FactoryRunsStore,
} from "@/modules/factory";
import { useCanvasHotkeyOverrides } from "./useCanvasHotkeySettings";
import { onDockFactoryRunRequest } from "../services/dock-factory-request";
import { subscribeOpenInCode, type OpenInCodeRequest } from "../services/open-in-code";
import type { NeedsYouAsk } from "../services/needs-you-queue";
import { automationNeedsYouAsks, factoryNeedsYouAsks, taskNeedsYouAsks, tasksInReview } from "../services/needs-you-sources";
import { useOptionalSharedTrackerBoard } from "@/modules/workspace-shell/hooks/TrackerBoardProvider";
import { detectCanvasHotkeyPlatform, effectiveBindings, formatChord, UNBOUND_CHORD } from "../services/canvas-hotkeys";

/**
 * The Canvas Dock's state (`plans/canvas-dock/`, revised 2026-10-16): one button, one panel on the
 * right, the apps on its own rail.
 *
 * Automation, Factory, Tasks and Fleet live in the Dock. Tasks reads the window's one tracker
 * board (`TrackerBoardProvider`, S4). Connectors joins when it has a slice: a rail item for an app
 * that cannot open yet would be a button that does nothing.
 *
 * The automation client is created here, not inside the panel, so the button's badge counts what
 * waits while the Dock is closed — the same reason the workspace shell reads it outside its panel.
 */
export type CanvasDockApp = "automation" | "factory" | "tasks" | "fleet" | "code";

/** A file another part of the canvas asked Code to open; `seq` makes a repeat of the same file new. */
export interface CodeOpenRequest extends OpenInCodeRequest {
  seq: number;
}

export interface CanvasDockWaiting {
  app: CanvasDockApp;
  label: string;
  count: number;
}

export interface CanvasDock {
  open: boolean;
  app: CanvasDockApp;
  /** ⌘\ — the whole window instead of 452px, so a detail pane fits beside the list. */
  wide: boolean;
  toggle: () => void;
  show: (app?: CanvasDockApp) => void;
  close: () => void;
  toggleWide: () => void;
  automation: { client: AutomationClient; subscribe: Subscribe; openAsk: OpenAskRequest | null };
  /**
   * Every Factory Run, from the process-wide store the canvas nodes read (one read for all), and
   * the run a node asked to open (`factoryWorkflowId`), or null.
   */
  factory: {
    runs: Pick<FactoryRunsHandle, "rows" | "groups" | "loading" | "error" | "needsYou">;
    focusKey: string | null;
    /** Bumped by ⌘K's "New Factory run…": the surface opens New run once per value. 0 = none. */
    newRunRequest?: number;
  };
  /** Opens the Dock's Factory on one run (Tasks' "Open in Factory"). */
  showFactoryRun: (repo: string, issue: FactoryRef) => void;
  /** Opens the Dock's Factory with New run showing (⌘K). */
  showFactoryNewRun: () => void;
  /** The file `openInCode` asked Code to open, or null. Code opens it when it mounts or `seq` changes. */
  code: { request: CodeOpenRequest | null };
  /** The task a Needs-you row asked Tasks to open, or null; `seq` remounts Tasks on it. */
  tasks: { focus: { id: string; seq: number } | null };
  /** Opens the Dock's Tasks on one task (a linked Task node's "open ↗"). */
  showTask: (taskId: string) => void;
  /** Each app with something waiting for the user, in rail order. Empty when nothing waits. */
  waiting: CanvasDockWaiting[];
  /** Sum of `waiting`: the one badge on the Dock button. */
  waitingTotal: number;
  /**
   * The same waiting items, one per row, for the canvas's one Needs-you queue (S5): each opens the
   * Dock where it is answered. Agents join the queue from their own status registry.
   */
  asks: NeedsYouAsk[];
}

const WIDE_KEY = "lotus.canvas.dock.wide";

function readWide(): boolean {
  try {
    return globalThis.localStorage?.getItem(WIDE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeWide(wide: boolean): void {
  try {
    globalThis.localStorage?.setItem(WIDE_KEY, wide ? "1" : "0");
  } catch {
    // A private window or blocked storage: the width just isn't remembered.
  }
}

export function useCanvasDock(
  options: { automationClient?: AutomationClient; subscribe?: Subscribe; factoryStore?: FactoryRunsStore } = {},
): CanvasDock {
  const [open, setOpen] = useState(false);
  const [app, setApp] = useState<CanvasDockApp>("automation");
  const [wide, setWide] = useState(readWide);
  // Code opens wider than the saved width, for this opening only; see `effectiveWide`.
  const [codeWide, setCodeWide] = useState(false);
  const client = useMemo(() => options.automationClient ?? createTauriAutomationClient(), [options.automationClient]);
  const subscribe = options.subscribe ?? subscribeToAutomationChanges;
  const automationDrafts = usePendingDrafts(client, subscribe);
  const automationWaiting = automationDrafts.length;
  const { rows: factoryRows, loading: factoryLoading } = useSharedFactoryRuns(options.factoryStore);
  const [factoryFocus, setFactoryFocus] = useState<string | null>(null);
  // Spent by any other way into or out of the Dock, so a later remount of Factory does not reopen it.
  const [newRunRequest, setNewRunRequest] = useState(0);
  // The window's one tracker board (S4); absent in tests that render the Dock alone.
  const tracker = useOptionalSharedTrackerBoard();
  const trackerTasks = tracker?.board.tasks;
  const trackerProjects = tracker?.board.projectsById;
  const [taskFocus, setTaskFocus] = useState<{ id: string; seq: number } | null>(null);
  // A Factory node's double-click: the Dock opens on that run, with no trip to `/`.
  useEffect(
    () =>
      onDockFactoryRunRequest(({ repo, issue }) => {
        setFactoryFocus(factoryWorkflowId(repo, issue));
        setApp("factory");
        setOpen(true);
      }),
    [],
  );

  // An Ask's notification, followed while on the canvas, opens the Dock's Inbox on that Ask
  // (AppShell no longer sends /canvas Home for it). Only requests made after this canvas mounted:
  // one left over from a trip through Home must not pop the Dock open on arrival.
  const openAsk = useSyncExternalStore(subscribeToOpenAskRequest, openAskRequest, () => null);
  const seqAtMount = useRef(openAskRequest()?.seq ?? 0);
  const askSeq = openAsk?.seq ?? 0;
  useEffect(() => {
    if (askSeq <= seqAtMount.current) return;
    setApp("automation");
    setOpen(true);
  }, [askSeq]);
  // Spent once Automation is no longer showing, as in the workspace shell.
  const showingAutomation = open && app === "automation";
  const wasShowing = useRef(showingAutomation);
  useEffect(() => {
    if (wasShowing.current && !showingAutomation && openAskRequest()) clearOpenAskRequest();
    wasShowing.current = showingAutomation;
  }, [showingAutomation]);

  // Code opens widened (the editor wants room) — for this opening only: `codeWide` is a temporary
  // flag, so the saved width (for the other apps) is never overwritten. Opening it while it is
  // showing leaves the width alone.
  const [codeRequest, setCodeRequest] = useState<CodeOpenRequest | null>(null);
  const codeRequestSeq = useRef(0);
  const showingCode = open && app === "code";
  const showingCodeRef = useRef(false);
  showingCodeRef.current = showingCode;
  // Spent once Code is no longer showing: the Code app replays a request it finds when it mounts, so
  // a request left behind would reopen that file every time the Dock comes back to Code.
  useEffect(() => {
    if (showingCode) return;
    setCodeWide(false);
    setCodeRequest(null);
  }, [showingCode]);
  useEffect(
    () =>
      subscribeOpenInCode((request) => {
        if (!showingCodeRef.current) setCodeWide(true);
        codeRequestSeq.current += 1;
        const seq = codeRequestSeq.current;
        setCodeRequest({ ...request, seq });
        setApp("code");
        setOpen(true);
      }),
    [],
  );

  const toggle = useCallback(() => {
    setNewRunRequest(0);
    setOpen((was) => !was);
  }, []);
  const show = useCallback((next?: CanvasDockApp) => {
    setNewRunRequest(0);
    if (next) setApp(next);
    // The rail's Factory opens the list, not the run a node opened earlier; Tasks likewise.
    if (next === "factory") setFactoryFocus(null);
    if (next === "tasks") setTaskFocus(null);
    if (next === "code" && !showingCodeRef.current) setCodeWide(true);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setNewRunRequest(0);
    setOpen(false);
  }, []);
  const effectiveWide = showingCode && codeWide ? true : wide;
  const effectiveWideRef = useRef(effectiveWide);
  effectiveWideRef.current = effectiveWide;
  // The user's own press is a preference, so it is the one thing that writes the saved width.
  const toggleWide = useCallback(() => {
    const next = !effectiveWideRef.current;
    setCodeWide(false);
    setWide(next);
    writeWide(next);
  }, []);

  const factoryWaiting = needsYouCount(factoryRows);
  const tasksWaiting = useMemo(
    () => (trackerTasks && trackerProjects ? tasksInReview(trackerTasks, trackerProjects).length : 0),
    [trackerTasks, trackerProjects],
  );
  const waiting = useMemo<CanvasDockWaiting[]>(
    () =>
      [
        { app: "automation" as const, label: "Automation", count: automationWaiting },
        { app: "factory" as const, label: "Factory", count: factoryWaiting },
        { app: "tasks" as const, label: "Tasks", count: tasksWaiting },
      ].filter((item) => item.count > 0),
    [automationWaiting, factoryWaiting, tasksWaiting],
  );
  const showFactoryRun = useCallback((repo: string, issue: FactoryRef) => {
    setNewRunRequest(0);
    setFactoryFocus(factoryWorkflowId(repo, issue));
    setApp("factory");
    setOpen(true);
  }, []);
  const showFactoryNewRun = useCallback(() => {
    setFactoryFocus(null);
    setNewRunRequest((was) => was + 1);
    setApp("factory");
    setOpen(true);
  }, []);
  const waitingTotal = waiting.reduce((sum, item) => sum + item.count, 0);
  const askForDock = askSeq > seqAtMount.current ? openAsk : null;
  const automation = useMemo(() => ({ client, subscribe, openAsk: askForDock }), [client, subscribe, askForDock]);

  const factory = useMemo(
    () => ({
      runs: { rows: factoryRows, groups: groupFactoryRuns(factoryRows), loading: factoryLoading, error: null, needsYou: factoryWaiting },
      focusKey: factoryFocus,
      newRunRequest,
    }),
    [factoryRows, factoryLoading, factoryWaiting, factoryFocus, newRunRequest],
  );

  const asks = useMemo<NeedsYouAsk[]>(
    () => [
      ...factoryNeedsYouAsks(factoryRows, (row) => {
        setFactoryFocus(factoryWorkflowId(row.repo, row.issue));
        setApp("factory");
        setOpen(true);
      }),
      // The Ask channel opens Automation › Inbox on that row (below); it takes any waiting row.
      ...automationNeedsYouAsks(automationDrafts, (draft) => requestOpenAsk(draft.id)),
      ...(trackerTasks && trackerProjects
        ? taskNeedsYouAsks(trackerTasks, trackerProjects, (task) => {
            setTaskFocus((was) => ({ id: task.id, seq: (was?.seq ?? 0) + 1 }));
            setApp("tasks");
            setOpen(true);
          })
        : []),
    ],
    [factoryRows, automationDrafts, trackerTasks, trackerProjects],
  );
  const tasks = useMemo(() => ({ focus: taskFocus }), [taskFocus]);
  const code = useMemo(() => ({ request: codeRequest }), [codeRequest]);
  // A linked Task node's "open ↗" (board 18): the Dock's Tasks, on that task's row.
  const showTask = useCallback((taskId: string) => {
    setTaskFocus((was) => ({ id: taskId, seq: (was?.seq ?? 0) + 1 }));
    setApp("tasks");
    setOpen(true);
  }, []);

  return { open, app, wide: effectiveWide, toggle, show, close, toggleWide, automation, factory, showFactoryRun, showFactoryNewRun, code, tasks, showTask, waiting, waitingTotal, asks };
}

/** "Automation 2 · Tasks 1" — what the button's tooltip and label say waits. */
export function describeDockWaiting(waiting: readonly CanvasDockWaiting[]): string {
  return waiting.map((item) => `${item.label} ${item.count}`).join(" · ");
}

/** The Dock chords as the user has them bound ("⌘B", "⌘\"), or "" when unbound. */
export function useCanvasDockChords(): { toggle: string; widen: string } {
  const { overrides } = useCanvasHotkeyOverrides();
  return useMemo(() => {
    const bindings = effectiveBindings(overrides);
    const label = (chord: string) => (chord === UNBOUND_CHORD ? "" : formatChord(chord, detectCanvasHotkeyPlatform()).join(""));
    return { toggle: label(bindings["toggle-dock"]), widen: label(bindings["widen-dock"]) };
  }, [overrides]);
}
