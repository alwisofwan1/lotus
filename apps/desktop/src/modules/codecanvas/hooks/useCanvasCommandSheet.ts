"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Node } from "@xyflow/react";
import { detectInstalledClis, listAccounts, type DetectedCli } from "@/lib/tauri-api";
import { sshProbeWorkspace, type RemoteCapabilityProfile } from "@/lib/tauri/codespace-editor-ssh";
import { getActiveProjectLocation } from "../services/canvas-active-project";
import { machineKey, wireTarget } from "../services/machine";
import { clisOnMachine } from "../services/machine-runners";
import { hostFleetFor, type RemoteHostCell } from "../services/remote-host";
import type { CanvasCommand } from "../services/commands/canvas-command";
import {
  buildCommandSheetItems,
  buildFileSheetItems,
  buildOpenFileBrowseRow,
  filterCommandSheetItems,
  isBrowseMode,
  shouldAutoOpenSheet,
  type SheetFactoryRun,
  type SheetItem,
  type SheetTrackerTask,
} from "../services/commands/command-sheet-items";
import { cycleAccount } from "@/modules/workspace-shell/services/agent-catalog";
import { factoryNextStep, factoryRunDetail, useSharedFactoryRuns } from "@/modules/factory";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { useCanvasSessions } from "./useCanvasSessions";
import type { CanvasSessionRecord } from "../services/session-record";
import { agentSessionControlRegistry } from "../services/session-control-registry";

/**
 * The ⌘K command sheet, merged into the NL command bar (2026-08-28).
 *
 * There used to be a centred modal with an input of its own. It meant two places to type a command
 * and two catalogs of what a command is — and the moment the user had already typed into the bar,
 * ⌘K stole focus and left their words behind on the other surface. This hook is the sheet's whole
 * behaviour; the bar owns the input, the query and the send pipeline, exactly as it already did.
 *
 * Open/close is deliberately three-way, not a boolean:
 *   • ⌘K            → open with whatever is in the bar (usually nothing)
 *   • typing        → open ITSELF once the query looks like a command and the catalog agrees
 *   • Escape        → close, and stay closed for THIS query
 *
 * That last latch is the part a boolean cannot express. Without it, Escape closes the sheet and the
 * auto-open rule immediately re-opens it on the next render, because the query that triggered it is
 * still in the bar — a dismissal that does not stick reads as a broken key.
 */

interface SheetNav {
  projects?: CodeCanvasProjectMeta[];
  activeProjectId?: string | null;
  onSelectProject?: (projectId: string) => void;
  onOpenCanvases?: () => void;
  onOpenSettings?: () => void;
  onStopAllSpeech?: () => void;
  /** Take over a cell the project's machine already runs under its own Standalone Host. */
  onAdoptHostCell?: (cell: RemoteHostCell) => void;
  /** Place an issue's Factory Run on the canvas (#146). */
  onAddFactoryRun?: (run: SheetFactoryRun) => void;
  /** Open a run that waits for you in the Dock's Factory. */
  onOpenFactoryRun?: (run: SheetFactoryRun) => void;
  /** Open the Dock's Factory on New run. */
  onNewFactoryRun?: () => void;
  /** Open the Dock on Automation. */
  onOpenAutomation?: () => void;
  onOpenFleet?: () => void;
  /** Open tasks on the tracker board, and placing one as a linked Task node (board 18). */
  trackerTasks?: SheetTrackerTask[];
  onPlaceTask?: (task: SheetTrackerTask, options?: { openInDock?: boolean }) => void;
  /** "Open file…": place a File Node for this absolute path (plans/canvas-code, S3). */
  onOpenFile?: (path: string) => void;
  /** Every file under the project root; called each time the sheet opens, results ranked per query. */
  loadProjectFiles?: () => Promise<string[]>;
  /** The canvas project root, to show a file's folder relative to it. */
  rootDir?: string;
}

interface Options {
  /** The bar's live text. The sheet never holds a query of its own. */
  query: string;
  nodes: Node[];
  /** App-effect callbacks. Absent ones simply contribute no rows. */
  nav?: SheetNav;
  runCommand: (command: CanvasCommand) => unknown;
  /** Send the raw query through the NL pipeline — the "Do it: …" row. */
  onSend: () => void;
  /** Clear the bar's text after a catalog row runs (a command consumed the query). */
  onClearQuery: () => void;
  /**
   * False while the bar cannot host a sheet — a live voice session replaces the input outright, and
   * a submit in flight would run a command against a query that is already being consumed.
   */
  enabled: boolean;
  /** Called when ⌘K is pressed, before opening: focus the bar, end a live voice session. */
  onInvoke?: () => void;
  /**
   * Press a session row. The sheet decides nothing about sessions itself — every surface routes
   * through the one dispatcher (`plans/codecanvas-session-refactor/issues/03`).
   */
  onDispatchSession?: (session: CanvasSessionRecord) => void | Promise<void>;
}

/** No row is selected. An auto-opened sheet rests here; see `activeIndex` in the hook. */
export const NO_ROW = -1;

export interface CanvasCommandSheet {
  open: boolean;
  /** True for the sectioned browse list, false for the flat ranked search list. */
  grouped: boolean;
  /** Filtered catalog plus the trailing send row — the exact rows on screen, in order. */
  items: SheetItem[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  close: () => void;
  /**
   * Run row `index` (defaults to the active one); `alt` runs its ⌘↵ action where it has one.
   * Returns false when there was nothing to run.
   */
  run: (index?: number, alt?: boolean) => boolean;
  /**
   * Feed the bar's textarea keydown here FIRST. Returns true when the sheet consumed the key, in
   * which case the bar must not also act on it — the one contract that keeps Enter from both
   * running a row and submitting the prose behind it.
   */
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

export function useCanvasCommandSheet({
  query,
  nodes,
  nav,
  runCommand,
  onSend,
  onClearQuery,
  enabled,
  onInvoke,
  onDispatchSession,
}: Options): CanvasCommandSheet {
  /**
   * Openness is DERIVED, not stored — see `isOpen` below. Only two things are real state: whether
   * ⌘K was pressed, and which query the user has already dealt with.
   *
   * The first draft stored an "openedBy" enum and reconciled it in an effect, and that effect was
   * wrong twice over: it cascaded a render on every keystroke, and it fought the shortcut (⌘K opens
   * with an empty query, which the auto-open rule scores as "no match", so the effect closed what
   * the shortcut had just opened). Deriving it makes both problems unrepresentable.
   */
  const [invoked, setInvoked] = useState(false);
  /** The query the user has finished with — dismissed with Escape, or already acted on. */
  const [settled, setSettled] = useState<string | null>(null);
  const [clis, setClis] = useState<DetectedCli[]>([]);
  /** Signed-in Claude accounts besides `default`, cycled with ⇥ on the Launch Claude row. */
  const [claudeAccounts, setClaudeAccounts] = useState<string[]>([]);
  /** The account ⇥ picked on the Launch Claude row; null = the default (decision 6). */
  const [launchAccount, setLaunchAccount] = useState<string | null>(null);
  /**
   * The active row, stamped with the query it was chosen under. Derived rather than reset in an
   * effect: after re-filtering, row 3 is a different command, so an index from a stale query must
   * fall back to the default — and it does, because the stamp no longer matches.
   *
   * NO_ROW is the important value. See `activeIndex`.
   */
  const [anchor, setAnchor] = useState<{ query: string; index: number }>({ query: "", index: NO_ROW });
  const loadedClis = useRef(false);
  /**
   * What the active project's machine can actually start.
   *
   * The Launch rows are built from CLIs detected **on this desktop**, which is the wrong machine the
   * moment the project lives elsewhere — that is how an agent came to be launched against a `claude`
   * the VPS did not have (2026-09-15). `null` means not asked, and an unasked machine keeps every
   * row: "not probed" must never render as "not installed".
   */
  const [machineProfile, setMachineProfile] = useState<RemoteCapabilityProfile | null>(null);
  /**
   * Cells the machine's own Standalone Host is running, when it runs one (ticket 11).
   *
   * Empty until the probe says there is a host to ask, and empty again the moment the project moves
   * to a machine without one — so a board on an ordinary SSH host never sees a trace of this.
   */
  const [hostCells, setHostCells] = useState<RemoteHostCell[]>([]);
  const machine = getActiveProjectLocation();
  const machineKeyValue = machineKey(machine);

  useEffect(() => {
    if (!machine) {
      setMachineProfile(null);
      return;
    }
    let live = true;
    const target = wireTarget(machine);
    // Cached in Rust per machine for five minutes, so a reopen of the sheet costs nothing — and asked
    // again on each ⌘K open, so "Cek ulang mesin" shows up the next time the sheet is opened.
    void sshProbeWorkspace(target)
      .then((profile) => { if (live) setMachineProfile(profile); })
      .catch(() => { if (live) setMachineProfile(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- machineKeyValue stands in for the machine
  }, [machineKeyValue, invoked]);

  /**
   * Ask the host what it is running — but only once the probe has said there is one.
   *
   * Gated on the probe rather than asked unconditionally because the alternative is an SSH round
   * trip on every project open, on every machine, to learn "no" about a feature that is optional by
   * design. The probe's answer is cached per machine in Rust; this is not, because a cell started
   * from a phone a minute ago is exactly what we are looking for.
   */
  useEffect(() => {
    if (!machine || !machineProfile?.hasLotusHost) {
      setHostCells([]);
      return;
    }
    let live = true;
    void hostFleetFor(machine).then((fleet) => {
      if (live) setHostCells(fleet.available ? fleet.cells : []);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- machineKeyValue stands in for the machine
  }, [machineKeyValue, machineProfile?.hasLotusHost, open]);

  // Installed CLIs back the Launch rows. Loaded once per mount rather than per open (the old modal
  // rescanned on every open, which is a filesystem probe on a keystroke).
  useEffect(() => {
    if (loadedClis.current) return;
    loadedClis.current = true;
    void detectInstalledClis()
      .then((list) => setClis(list.filter((c) => c.installed)))
      // Total by contract: no CLIs simply means no Launch rows, never a dead command bar.
      .catch(() => setClis([]));
  }, []);

  // Asked on each open: an account added in Settings shows up the next time the sheet opens. Local
  // projects only: an account id names a folder on this desktop.
  // shortcut: no account rows for a project on another machine, until host PTY spawns take one (slice B).
  useEffect(() => {
    if (!open || machine) return;
    let live = true;
    void listAccounts()
      .then((rows) => { if (live) setClaudeAccounts(rows.filter((a) => a.id !== "default" && a.identity && !a.hidden).map((a) => a.id)); })
      .catch(() => { if (live) setClaudeAccounts([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- machineKeyValue stands in for the machine
  }, [open, machineKeyValue]);

  // Sessions are read here rather than threaded down through the bar's props: the sheet already
  // knows the active project, and `runCommand` already reaches the canvas. Adding two more fields
  // to the nav channel would have made three components carry data only this catalog uses.
  const { sessions } = useCanvasSessions(nav?.activeProjectId ?? null);

  // Read through the registry at build time so a row's verb reflects the canvas as it is now: a
  // session whose node lives on another canvas says "Pasang", not "Lanjutkan".
  const sessionBoard = useMemo(
    () => ({
      projectId: nav?.activeProjectId ?? null,
      isRegistered: (nodeId: string) => Boolean(agentSessionControlRegistry.get(nodeId)),
      isDormant: (nodeId: string) => agentSessionControlRegistry.get(nodeId)?.isDormant() ?? false,
      activeSessionId: (nodeId: string) =>
        agentSessionControlRegistry.get(nodeId)?.activeSessionId() ?? null,
    }),
    [nav?.activeProjectId],
  );

  // Read the same way the Factory nodes read them: one shared list, live on every run change.
  const { rows: factoryRows } = useSharedFactoryRuns();
  const factoryRuns = useMemo<SheetFactoryRun[]>(
    () => factoryRows.map((row) => ({ repo: row.repo, issue: row.issue, title: row.title, statusWord: factoryRunDetail(row).statusWord, next: factoryNextStep(row) })),
    [factoryRows],
  );

  const catalog = useMemo(
    () =>
      buildCommandSheetItems({
        nodes,
        clis: clisOnMachine(clis, machineProfile),
        claudeAccounts: machine ? [] : claudeAccounts,
        launchAccount,
        onCycleAccount: () => setLaunchAccount((current) => cycleAccount(claudeAccounts, current)),
        onOpenSettings: nav?.onOpenSettings,
        onOpenCanvases: nav?.onOpenCanvases,
        onStopAllSpeech: nav?.onStopAllSpeech,
        projects: nav?.projects,
        activeProjectId: nav?.activeProjectId,
        onSelectProject: nav?.onSelectProject,
        sessions,
        sessionBoard,
        hostCells,
        onAdoptCell: (cell) => nav?.onAdoptHostCell?.(cell),
        factoryRuns,
        onAddFactoryRun: nav?.onAddFactoryRun,
        onOpenFactoryRun: nav?.onOpenFactoryRun,
        onNewFactoryRun: nav?.onNewFactoryRun,
        onOpenAutomation: nav?.onOpenAutomation,
        onOpenFleet: nav?.onOpenFleet,
        trackerTasks: nav?.trackerTasks,
        onPlaceTask: nav?.onPlaceTask,
        onDispatchSession: (session) => {
          // Focus first: work the user cannot see reads as the row having done nothing. Only for a
          // node that is actually here — the dispatcher does its own focusing when it makes one.
          if (session.nodeId && agentSessionControlRegistry.get(session.nodeId)) {
            runCommand({ kind: "focus-node", nodeId: session.nodeId });
          }
          void onDispatchSession?.(session);
        },
      }),
    [nodes, clis, claudeAccounts, launchAccount, machineProfile, hostCells, factoryRuns, nav?.onAddFactoryRun, nav?.onOpenFactoryRun, nav?.onNewFactoryRun, nav?.onOpenAutomation, nav?.onOpenFleet, nav?.trackerTasks, nav?.onPlaceTask, nav?.onAdoptHostCell, nav?.onOpenSettings, nav?.onOpenCanvases, nav?.onStopAllSpeech, nav?.projects, nav?.activeProjectId, nav?.onSelectProject, sessions, sessionBoard, onDispatchSession, runCommand],
  );

  // Files are ranked per query (a project can hold 100k+), so they sit beside the catalog rather
  // than in it. The index is read when the sheet opens, not on every board mount.
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const loadProjectFiles = nav?.loadProjectFiles;
  const wantsFiles = Boolean(nav?.onOpenFile && loadProjectFiles) && enabled && (invoked || query.trim().length >= 2);
  useEffect(() => {
    if (!wantsFiles || !loadProjectFiles) return;
    let cancelled = false;
    void loadProjectFiles().then((files) => { if (!cancelled) setProjectFiles(files); }, () => {});
    return () => { cancelled = true; };
    // Once per opening: typing must not re-walk the project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsFiles, loadProjectFiles]);
  const fileRows = useMemo(
    () => !query.trim() ? buildOpenFileBrowseRow({ onOpenFile: nav?.onOpenFile }) : buildFileSheetItems({
      query,
      files: projectFiles,
      rootDir: nav?.rootDir ?? "",
      onBoard: new Set(nodes.filter((n) => n.type === "file").map((n) => String(n.data?.path ?? ""))),
      onOpenFile: nav?.onOpenFile,
    }),
    [query, projectFiles, nav?.rootDir, nav?.onOpenFile, nodes],
  );

  const items = useMemo(() => filterCommandSheetItems(catalog, query, onSend, fileRows), [catalog, query, onSend, fileRows]);

  /**
   * Close, and mark the current query settled so the auto-open rule does not immediately undo it.
   *
   * That second half is the part a boolean cannot express. Escape closes the sheet while the query
   * that opened it is still sitting in the bar, so without the latch the very next render re-opens
   * it — a dismissal that does not stick reads as a broken key. Running a row settles the query for
   * the same reason: the user has acted on those words, so they must not be re-offered.
   */
  const close = useCallback(() => {
    setInvoked(false);
    setSettled(query);
    setAnchor({ query, index: NO_ROW });
  }, [query]);

  // ⌘K / Ctrl+K. Window-level because the canvas, a node, or nothing at all may hold focus — the
  // point of the shortcut is that it works from anywhere.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) return;
      event.preventDefault();
      onInvoke?.();
      // A fresh invocation clears any standing dismissal: the user asked for the sheet explicitly.
      setSettled(null);
      // Index 0: an explicitly invoked sheet selects its first row, so Enter runs immediately.
      setAnchor({ query: "", index: 0 });
      setInvoked(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onInvoke]);

  // Hybrid auto-open, as a pure question about the current query. Asked of the CATALOG, not of
  // `items`, because the send row matches everything and would make the rule vacuous.
  const autoWanted = query !== settled && shouldAutoOpenSheet(catalog, query);

  /**
   * Openness, derived. Named explicitly rather than left as a bare `open`: a bare `open` in this
   * scope does not fail to compile, it silently resolves to the DOM global `window.open`, which is
   * always truthy. An earlier draft's keyboard guard read `if (!open) return false` and so never
   * returned early — the sheet consumed Enter even while closed, and the bar could never submit
   * prose at all. tsc had nothing to say about it; a test caught it.
   *
   * `enabled` gates the result rather than clearing `invoked`, so a ⌘K pressed during a live voice
   * session is honoured once that session ends. The shortcut ends the session itself (onInvoke), and
   * a request that quietly evaporated would be the worse behaviour.
   */
  const isOpen = enabled && (invoked || autoWanted);

  /**
   * The active row, or NO_ROW.
   *
   * A SELF-OPENED sheet starts with nothing selected, and that is the whole contract that lets it
   * open on its own without changing what the bar does. Typing "add a terminal" and pressing Enter
   * has always gone to the NL pipeline; the first build made the sheet own Enter the moment it
   * appeared, so the same keystrokes silently started running a catalog row instead — a surface
   * that opened itself and then hijacked the primary key. Caught by the bar's own suite.
   *
   * So: an auto-opened sheet is ADVISORY. It shows what ⌘K would offer, and Enter still submits the
   * prose. One press of ↓ (or ↑, which jumps to the last row) selects a row, and from then on Enter
   * runs it — the ordinary autocomplete contract a URL bar has. A sheet opened by ⌘K is different:
   * the user asked for the list, so its first row is selected immediately.
   */
  const activeIndex = anchor.query === query ? anchor.index : (invoked ? 0 : NO_ROW);
  const safeIndex = activeIndex < 0 ? NO_ROW : Math.min(activeIndex, Math.max(items.length - 1, 0));
  const setActiveIndex = useCallback((index: number) => setAnchor({ query, index }), [query]);

  const run = useCallback(
    (index?: number, alt = false) => {
      const item = items[index ?? safeIndex];
      if (!item) return false;
      if (item.action.kind === "command") runCommand(item.action.command);
      else if (alt && item.action.alt) item.action.alt.run();
      else item.action.run();
      if (item.cycle) setLaunchAccount(null);
      // "Open file…" only readies the bar: keep the sheet and hand focus back for typing.
      if (item.action.kind === "custom" && item.action.keepOpen) {
        onInvoke?.();
        return true;
      }
      // The send row consumes the query itself (the bar clears on submit); a catalog row does not,
      // and leaving "creat" sitting in the bar after Create Task ran would re-open the sheet.
      if (item.group !== "send") onClearQuery();
      close();
      return true;
    },
    [items, safeIndex, runCommand, onClearQuery, onInvoke, close],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!isOpen) return false;
      // Consumed keys are stopped here as well as prevented: Escape and the arrows all mean
      // something to the canvas behind the bar (deselect, pan), and a sheet that let them through
      // would move the viewport while the user was only walking a list.
      const consume = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.key === "ArrowDown") {
        consume();
        // From NO_ROW (-1) this lands on 0, which is how the first ↓ adopts the list.
        setActiveIndex(Math.min(safeIndex + 1, Math.max(items.length - 1, 0)));
        return true;
      }
      if (event.key === "ArrowUp") {
        consume();
        // ↑ with nothing selected jumps to the LAST row, as a URL bar does — and that row is
        // "send what you typed", so the escape hatch is always one keystroke away.
        setActiveIndex(safeIndex === NO_ROW ? Math.max(items.length - 1, 0) : Math.max(safeIndex - 1, 0));
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        // NOT consumed when no row is selected: the sheet is advisory and the bar owns Enter.
        if (safeIndex === NO_ROW) return false;
        consume();
        return run(undefined, event.metaKey || event.ctrlKey);
      }
      if (event.key === "Tab" && !event.shiftKey && items[safeIndex]?.cycle) {
        consume();
        items[safeIndex].cycle!();
        return true;
      }
      if (event.key === "Escape") {
        consume();
        // close() latches the dismissal against the current query — see its comment.
        close();
        return true;
      }
      return false;
    },
    [isOpen, safeIndex, items.length, run, close, setActiveIndex],
  );

  return { open: isOpen, grouped: isBrowseMode(query), items, activeIndex: safeIndex, setActiveIndex, close, run, handleKeyDown };
}
