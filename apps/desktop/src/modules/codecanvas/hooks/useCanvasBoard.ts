import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { getHomedir, isTauri } from "@/lib/tauri-api";
import type {
  CodeCanvasProjectLocation,
  CodeCanvasProjectMeta,
  CodeCanvasProjectSnapshot,
} from "@/lib/tauri/codecanvas";
import { closeWorkspaceTerminalSessions } from "@/modules/codespace/services/terminal-session-registry";
import { destroyScopePersistentPtys } from "@/lib/pty-session-pool";
import { collectCanvasBrowserTeardownIds, teardownCanvasBrowsers } from "../services/canvas-browser-teardown";
import { toCanvasSnapshot } from "../services/canvas-serialize";
import { decodeCanvasSnapshot } from "../services/canvas-snapshot-codec";
import {
  createCodeCanvasProjectRepository,
  type CodeCanvasProjectRepository,
} from "../services/codecanvas-project-repository";
import { canvasRuntimeScope } from "../services/canvas-runtime-scope";
import { canvasProjectViewStateStore } from "../services/canvas-project-view-state";
import { activeFrameCanvasKey, canvasActiveFrameStore } from "../services/canvas-active-frame";
import { setActiveProjectLocation, setActiveProjectRootDir } from "../services/canvas-active-project";
import { contextBusStore } from "../services/context-bus-store";
import { contextBusRegistry } from "../services/context-bus-registry";
import { useCanvasAutosave } from "./useCanvasAutosave";
import { useCanvasNodes } from "./useCanvasNodes";

interface UseCanvasBoardOptions {
  repository?: CodeCanvasProjectRepository;
  teardownBrowsers?: (nodes: Node[]) => Promise<void>;
}

/** True once the first canvas boot of the app session has completed — see `booted` below. */
let hasBootedCanvasOnce = false;

/** Test-only: reset the module-level boot latch so each test starts from a cold boot. */
export function resetCanvasBootLatchForTests(): void {
  hasBootedCanvasOnce = false;
}

export function useCanvasBoard(options: UseCanvasBoardOptions = {}) {
  const repositoryRef = useRef(options.repository ?? createCodeCanvasProjectRepository());
  const teardownBrowsersRef = useRef(
    options.teardownBrowsers ?? ((nodes: Node[]) => teardownCanvasBrowsers(collectCanvasBrowserTeardownIds(nodes))),
  );
  const [loading, setLoading] = useState(true);
  // Module-scoped so it survives a CanvasPage remount (navigate away → back): the "Restoring
  // canvas…" splash should only appear on the very first cold boot of the app session, never on a
  // project switch or a return to the page — those keep the current canvas painted until the next
  // snapshot swaps in, which reads as an instant, production-grade transition.
  const [booted, setBooted] = useState(hasBootedCanvasOnce);
  const [projects, setProjects] = useState<CodeCanvasProjectMeta[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [rootDir, setRootDir] = useState("");
  const [pickerInput, setPickerInput] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const homeDefaultRef = useRef("");
  const projectTransitionSeqRef = useRef(0);
  const requestedProjectIdRef = useRef<string | null>(null);

  const rootDirRef = useRef("");
  const activeProjectIdRef = useRef<string | null>(null);
  const activeProjectRef = useRef<CodeCanvasProjectMeta | null>(null);
  rootDirRef.current = rootDir;
  activeProjectIdRef.current = activeProjectId;

  // Publish the active project root so leaf nodes (e.g. a browser node opening a
  // local file://) can read it as their confinement root without prop threading.
  useEffect(() => {
    setActiveProjectRootDir(rootDir);
  }, [rootDir]);


  const saveFnRef = useRef<((nodes: Node[], edges: Edge[]) => void | Promise<void>) | null>(null);
  const autosave = useCanvasAutosave(saveFnRef);
  const { schedule: scheduleAutosave, cancel: cancelAutosave } = autosave;
  // Viewport centre in flow coordinates, set by CanvasPage once ReactFlow exists. Only the Frame "+" and the
  // Frame tool read it (where a new EMPTY Frame goes); new nodes join the active Frame instead (decision 38).
  const spawnCentreRef = useRef<(() => { x: number; y: number } | null) | null>(null);
  const board = useCanvasNodes(rootDirRef, scheduleAutosave, activeProjectIdRef);
  const { noteContentRef, loadSnapshot, terminalCounterRef, noteCounterRef, browserCounterRef, shapeCounterRef, waitForNodeCloses } = board;

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  activeProjectRef.current = activeProject;

  // Same reasoning as the root directory above, for the machine that root lives on: a node's PTY
  // has to know whether `cwd` names a path here or on another host, and it is the project that
  // knows. Declared after `activeProject` on purpose — the dependency is read during render.
  useEffect(() => {
    setActiveProjectLocation(activeProject?.location ?? null);
  }, [activeProject?.location]);

  // Hydrate the Shared Context Bus from durable storage whenever the active project changes,
  // so artifacts agents published in earlier runs are available to read (and replaces any
  // prior project's buses). Stale responses from a fast project switch are ignored.
  useEffect(() => {
    if (!activeProjectId) { contextBusRegistry.hydrate([]); return; }
    let live = true;
    void contextBusStore.list(activeProjectId).then((artifacts) => { if (live) contextBusRegistry.hydrate(artifacts); });
    return () => { live = false; };
  }, [activeProjectId]);

  const projectSnapshotFromNodes = useCallback((meta: CodeCanvasProjectMeta, nodes: Node[], edges: Edge[]): CodeCanvasProjectSnapshot => {
    const snapshot = toCanvasSnapshot({
      id: meta.id,
      rootDir: meta.rootDir,
      nodes,
      edges,
      noteContent: noteContentRef.current,
      terminalCounter: terminalCounterRef.current,
      noteCounter: noteCounterRef.current,
      browserCounter: browserCounterRef.current,
      shapeCounter: shapeCounterRef.current,
    });
    return { ...meta, nodes: snapshot.nodes, edges: snapshot.edges, terminalCounter: snapshot.terminalCounter ?? 0, noteCounter: snapshot.noteCounter, browserCounter: snapshot.browserCounter, shapeCounter: snapshot.shapeCounter };
  }, [noteContentRef, terminalCounterRef, noteCounterRef, browserCounterRef, shapeCounterRef]);

  // Park + close the active project's native browser WebViews before the next project hydrates.
  // A browser WebView is a window-level child, NOT scoped to the canvas — without this it lingers at
  // its last on-screen bounds and repaints over the incoming project (the cross-project leak bug).
  const boardNodesRef = useRef<Node[]>(board.nodes);
  boardNodesRef.current = board.nodes;
  const teardownActiveBrowsers = useCallback(async () => {
    await teardownBrowsersRef.current(boardNodesRef.current);
  }, []);

  const prepareNodesForSaveRef = useRef<((nodes: Node[]) => Node[]) | null>(null);
  const setPrepareNodesForSave = useCallback((handler: ((nodes: Node[]) => Node[]) | null) => {
    prepareNodesForSaveRef.current = handler;
  }, []);

  const saveActiveProject = useCallback(async (nodes = board.nodes, edges = board.edges) => {
    const meta = activeProjectRef.current;
    if (!meta) return;
    const canonicalNodes = prepareNodesForSaveRef.current?.(nodes) ?? nodes;
    await repositoryRef.current.saveProject(projectSnapshotFromNodes(meta, canonicalNodes, edges));
  }, [board.edges, board.nodes, projectSnapshotFromNodes]);

  /**
   * Hook for the layer above to settle a transient view before the board is persisted and swapped.
   *
   * Focus mode lives in `CanvasPage`, above this hook, and its pre-focus snapshot lives in memory
   * only. `selectProject` / `openProject` / `closeProject` all saved `board.nodes` as they stood —
   * hero stretched, neighbours veiled by a class the codec never writes — so a switch away while
   * focused baked the focus geometry into the project file and dropped the veil, and the return
   * drew the hero beside an unveiled neighbour under a stale rail (2026-08-28). The callback
   * returns the nodes the save should persist, or `null` when there was nothing to settle.
   */
  const beforeBoardSwapRef = useRef<(() => Node[] | null) | null>(null);
  const setBeforeBoardSwap = useCallback((fn: (() => Node[] | null) | null) => {
    beforeBoardSwapRef.current = fn;
  }, []);
  const saveOutgoingBoard = useCallback(async () => {
    const current = await waitForNodeCloses();
    const settled = beforeBoardSwapRef.current?.() ?? null;
    const ids = new Set(current.nodes.map((node) => node.id));
    await saveActiveProject(settled?.filter((node) => ids.has(node.id)) ?? current.nodes, current.edges);
  }, [saveActiveProject, waitForNodeCloses]);

  saveFnRef.current = saveActiveProject;

  const hydrate = useCallback((snapshot: CodeCanvasProjectSnapshot | null) => {
    if (!snapshot) {
      activeProjectIdRef.current = null;
      setRootDir("");
      loadSnapshot({ schemaVersion: 1, id: "empty", rootDir: "", nodes: [], edges: [], terminalCounter: 0, noteCounter: 0 });
      return;
    }
    activeProjectIdRef.current = snapshot.id;
    setRootDir(snapshot.rootDir);
    const decoded = decodeCanvasSnapshot({
      schemaVersion: 1,
      id: snapshot.id,
      rootDir: snapshot.rootDir,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      terminalCounter: snapshot.terminalCounter,
      noteCounter: snapshot.noteCounter,
      browserCounter: snapshot.browserCounter,
    });
    if (!decoded.ok) {
      console.warn("[canvas] failed to decode snapshot", decoded.error);
      loadSnapshot({ schemaVersion: 1, id: snapshot.id, rootDir: snapshot.rootDir, nodes: [], edges: [], terminalCounter: 0, noteCounter: 0 });
      return;
    }
    if (decoded.repairs.length > 0) console.warn("[canvas] repaired snapshot", decoded.repairs);
    loadSnapshot(decoded.snapshot);
  }, [loadSnapshot]);

  useEffect(() => {
    let alive = true;
    repositoryRef.current.getIndex()
      .then(async (index) => {
        if (!alive) return;
        // Load BEFORE announcing, so `activeProjectId` and `rootDir` land in one commit — see
        // [`selectProject`] for what the half-switched render costs.
        const snapshot = index.activeProjectId
          ? await repositoryRef.current.loadProject(index.activeProjectId)
          : null;
        if (!alive) return;
        setProjects(index.projects);
        setActiveProjectId(index.activeProjectId);
        if (index.activeProjectId) hydrate(snapshot);
      })
      .finally(() => { if (alive) { setLoading(false); hasBootedCanvasOnce = true; setBooted(true); } });
    return () => { alive = false; cancelAutosave(); };
  }, [cancelAutosave, hydrate]);

  // Resolve the home directory once and offer it as the default picker path
  // so the field reads like "/Users/you/" instead of being blank.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    getHomedir()
      .then((home) => {
        if (!alive || !home) return;
        homeDefaultRef.current = home.endsWith("/") ? home : `${home}/`;
        setPickerInput((prev) => (prev.length === 0 ? homeDefaultRef.current : prev));
      })
      .catch(() => { /* no home default available */ });
    return () => { alive = false; };
  }, []);

  const openPicker = useCallback(() => {
    setPickerInput(homeDefaultRef.current);
    setShowPicker(true);
  }, []);

  const refreshIndex = useCallback(async () => {
    const index = await repositoryRef.current.getIndex();
    setProjects(index.projects);
    setActiveProjectId(index.activeProjectId);
    return index;
  }, []);

  /** Refreshes the project list WITHOUT touching which one is active — for callers that are
   *  about to announce the active project themselves, in one commit with its board. */
  const refreshProjectList = useCallback(async () => {
    const index = await repositoryRef.current.getIndex();
    setProjects(index.projects);
    return index;
  }, []);

  const openProject = useCallback(async (dir: string, location?: CodeCanvasProjectLocation | null) => {
    const root = dir.trim();
    if (!root) return null;
    const transitionSeq = projectTransitionSeqRef.current + 1;
    projectTransitionSeqRef.current = transitionSeq;
    requestedProjectIdRef.current = null;
    setLoading(true);
    try {
      await saveOutgoingBoard();
      cancelAutosave();
      const snapshot = await repositoryRef.current.openProject(root, location ?? null);
      if (projectTransitionSeqRef.current !== transitionSeq) {
        await repositoryRef.current.setActiveProject(activeProjectIdRef.current);
        return null;
      }
      requestedProjectIdRef.current = snapshot.id;
      // The list first, then id + board together: `refreshIndex` would announce the new active
      // project on its own, one render before its board exists (see [`selectProject`]).
      await refreshProjectList();
      if (projectTransitionSeqRef.current !== transitionSeq) {
        await repositoryRef.current.setActiveProject(activeProjectIdRef.current);
        return null;
      }
      await teardownActiveBrowsers();
      setActiveProjectId(snapshot.id);
      hydrate(snapshot);
      setShowPicker(false);
      return snapshot;
    } catch (error) {
      if (projectTransitionSeqRef.current === transitionSeq) {
        await repositoryRef.current.setActiveProject(activeProjectIdRef.current);
      }
      throw error;
    } finally {
      if (projectTransitionSeqRef.current === transitionSeq) setLoading(false);
    }
  }, [cancelAutosave, hydrate, refreshProjectList, saveOutgoingBoard, teardownActiveBrowsers]);

  const selectProject = useCallback(async (projectId: string) => {
    if (projectId === activeProjectIdRef.current) {
      setShowPicker(false);
      return;
    }
    const transitionSeq = projectTransitionSeqRef.current + 1;
    projectTransitionSeqRef.current = transitionSeq;
    requestedProjectIdRef.current = projectId;
    setLoading(true);
    try {
      await saveOutgoingBoard();
      cancelAutosave();
      // Load before changing the durable active-project pointer. A slower obsolete request can then
      // be dropped without making the repository disagree with the board still visible in the UI.
      const snapshot = await repositoryRef.current.loadProject(projectId);
      if (projectTransitionSeqRef.current !== transitionSeq) return;
      await repositoryRef.current.setActiveProject(projectId);
      if (projectTransitionSeqRef.current !== transitionSeq) {
        const latestProjectId = requestedProjectIdRef.current;
        if (latestProjectId) await repositoryRef.current.setActiveProject(latestProjectId);
        return;
      }
      await teardownActiveBrowsers();
      // Announce project id and board in one commit. Publishing the incoming id next to outgoing
      // nodes makes fleet consumers attribute agents to the wrong repository.
      setActiveProjectId(projectId);
      hydrate(snapshot);
      setShowPicker(false);
    } finally {
      if (projectTransitionSeqRef.current === transitionSeq) setLoading(false);
    }
  }, [cancelAutosave, hydrate, saveOutgoingBoard, teardownActiveBrowsers]);

  const renameProject = useCallback(async (projectId: string, alias: string | null) => {
    await repositoryRef.current.renameProject(projectId, alias);
    await refreshIndex();
  }, [refreshIndex]);

  const closeProject = useCallback(async (projectId: string) => {
    if (projectId !== activeProjectIdRef.current) {
      const index = await repositoryRef.current.closeProject(projectId);
      closeWorkspaceTerminalSessions(canvasRuntimeScope(projectId));
      destroyScopePersistentPtys(canvasRuntimeScope(projectId));
      canvasProjectViewStateStore.forget(projectId);
      canvasActiveFrameStore.forget(activeFrameCanvasKey(projectId));
      setProjects(index.projects);
      return;
    }

    const transitionSeq = projectTransitionSeqRef.current + 1;
    projectTransitionSeqRef.current = transitionSeq;
    requestedProjectIdRef.current = null;
    setLoading(true);
    try {
      beforeBoardSwapRef.current?.();
      await teardownActiveBrowsers();
      cancelAutosave();
      const index = await repositoryRef.current.closeProject(projectId);
      closeWorkspaceTerminalSessions(canvasRuntimeScope(projectId));
      // Agent PTYs survive a project *switch* but must die when the project is *closed*.
      destroyScopePersistentPtys(canvasRuntimeScope(projectId));
      canvasProjectViewStateStore.forget(projectId);
      canvasActiveFrameStore.forget(activeFrameCanvasKey(projectId));
      if (projectTransitionSeqRef.current !== transitionSeq) {
        const latestProjectId = requestedProjectIdRef.current ?? activeProjectIdRef.current;
        await repositoryRef.current.setActiveProject(latestProjectId);
        return;
      }
      requestedProjectIdRef.current = index.activeProjectId;
      const snapshot = index.activeProjectId
        ? await repositoryRef.current.loadProject(index.activeProjectId)
        : null;
      if (projectTransitionSeqRef.current !== transitionSeq) return;
      setProjects(index.projects);
      setActiveProjectId(index.activeProjectId);
      hydrate(snapshot);
    } finally {
      if (projectTransitionSeqRef.current === transitionSeq) setLoading(false);
    }
  }, [cancelAutosave, hydrate, teardownActiveBrowsers]);

  const confirmPicker = useCallback(() => { void openProject(pickerInput); }, [openProject, pickerInput]);

  return {
    ...board,
    spawnCentreRef,
    loading,
    booted,
    projects,
    activeProjectId,
    activeProject,
    rootDir,
    showPicker,
    pickerInput,
    setPickerInput,
    setShowPicker,
    openPicker,
    openProject,
    selectProject,
    renameProject,
    closeProject,
    saveActiveProject,
    setBeforeBoardSwap,
    setPrepareNodesForSave,
    autosave: autosave.state,
    confirmPicker,
  };
}
