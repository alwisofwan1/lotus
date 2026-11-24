import { useCallback, useRef } from "react";
import type { Edge, Node, ReactFlowInstance, XYPosition } from "@xyflow/react";
import { closeTerminalSession } from "@/modules/codespace/services/terminal-session-registry";
import { resetTerminalActivity } from "@/modules/codespace/services/terminal-activity-registry";
import { navigateCanvasBrowser } from "@/lib/tauri/canvas-browser";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { AgentDefinition, CanvasSkillPreview, SmartConvertDraft, TaskDispatchMode } from "../types/canvas";
import { deriveSkillPreviewFocusChain } from "../services/canvas-focus-chain";
import { getCanvasBehaviorSettings } from "../hooks/useCanvasBehaviorSettings";
import { shouldTidyOnMutation } from "../services/canvas-tidy-trigger";
import { CANVAS_MOTION, canvasMotionEnabled } from "../services/canvas-motion";
import { DEFAULT_NOTE_SIZE } from "../services/canvas-node-placement";
import { resolveCanvasBrowserPairIdentity } from "../services/canvas-browser-pair";

/**
 * Auto-focus a freshly-created node only when it won't fight the auto-tidy. When `tidyOnOpen`
 * (or `autoArrangeNotes` for a note) is active, the tidy reframes the WHOLE canvas a beat later —
 * panning to the single new node first just yanks the camera, then the tidy yanks it back. So when
 * a tidy is coming, the tidy owns the camera and we skip the per-node focus.
 */
function shouldAutoFocusOnCreate(command: CanvasCommand): boolean {
  if (!shouldFocusCanvasCommandResult(command)) return false;
  const flags = getCanvasBehaviorSettings();
  if (!flags.autoFocusNewNodes) return false;
  const isNote =
    command.kind === "create-note-drop-target" || (command.kind === "create-node" && command.nodeType === "note");
  return !shouldTidyOnMutation("open", isNote, flags);
}
import {
  AGENT_NODE_SIZE,
  canvasNodeSpawnSize,
  centerSpawnBurstOffset,
  centeredSpawnPosition,
} from "../services/canvas-spawn-position";
import { planCanvasBrowserControl } from "../services/canvas-browser-control";
import { type DrawApplication } from "../services/agent-draw/canvas-draw-runtime";
import { measureDiagramLabel } from "../services/agent-draw/measure-label";
import { planDiagramDraw } from "../services/agent-draw/diagram-draw-plan";

/** Nominal diagram box used to centre the anchor in the viewport before per-diagram stagger. */
const DIAGRAM_NOMINAL_SIZE = { w: 440, h: 520 };
import {
  shouldFocusCanvasCommandResult,
  type CanvasCommand,
  type CanvasCommandResult,
  type SpawnTaskStamp,
} from "../services/commands/canvas-command";

const AGENT_CENTER_SPAWN_WINDOW_MS = 600;

export interface CanvasCommandCenterOptions {
  addTerminalNode: (at?: XYPosition, frameId?: string) => string;
  addNoteNode: (at?: XYPosition, content?: string) => string;
  addPlanNode: (at?: XYPosition) => string;
  addTaskNode: (seed?: { title?: string; description?: string }, at?: XYPosition) => string;
  addContextNode: (at?: XYPosition) => string;
  addCriticNode: (at?: XYPosition) => string;
  addHumanGateNode: (at?: XYPosition) => string;
  addTeamNode: (at?: XYPosition) => string;
  addMusicNode: (at?: XYPosition) => string;
  /** Creates a Run Node over the claimable `memberIds`; null when none can be claimed. */
  addRunNode: (memberIds: string[]) => string | null;
  nodes: Node[];
  edges: Edge[];
  flowInstance: ReactFlowInstance<Node, Edge> | null;
  addAgentNode: (definition: AgentDefinition, at?: XYPosition, options?: { isolate?: boolean; teamLabel?: string; initialTask?: string; frameId?: string; spawnTask?: SpawnTaskStamp }) => string;
  addSkillsNode: (terminalId: string, cwd: string) => string;
  addSkillNode: (skill: CanvasSkillPreview, parentId: string) => string;
  spawnBrowserNode: (terminalId: string, url: string) => string;
  spawnStandaloneBrowserNode: (url: string) => string;
  closeBrowserNode: (nodeId: string) => void;
  removeNode: (nodeId: string, delayMs?: number) => void;
  markNodeLeaving: (nodeId: string) => void;
  /** Tag every node as leaving with a cascading delay; returns total ms until the last finishes. */
  markAllNodesLeaving: () => number;
  removeAllNodes: (delayMs?: number) => void;
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  focusNode: (nodeId: string) => void;
  focusNodes: (nodeIds: string[], primaryNodeId?: string) => void;
  /** Select a node and pan the MINIMUM distance to bring it on screen — no move if it already is.
   * Used by the side-by-side surfaces (Skills, the skill reader) where a cluster re-frame reads as
   * the camera flying away. Optional: falls back to focusNodes. */
  revealNodes?: (primaryNodeId: string, alsoShowIds?: string[]) => void;
  /** Explicit "fokus ke X" (NL/voice) enters focus MODE (layout morph); auto-focus-on-create and
   * MCP camera moves keep using the plain camera focusNode. Optional: falls back to focusNode. */
  enterFocusMode?: (nodeId: string) => void;
  dispatchTask: (nodeId: string, mode: TaskDispatchMode, runner?: AgentRunnerType, runnerCommand?: string) => void;
  convertNoteToTask: (nodeId: string, draft: SmartConvertDraft) => void;
  arrangeNodes: () => void;
  /** Commit a built agent draw batch to the board (drives the draw-diagram command). */
  commitAgentDraw: (application: DrawApplication) => void;
}

export function useCanvasCommandCenter({
  addTerminalNode,
  addNoteNode,
  addPlanNode,
  addTaskNode,
  addContextNode,
  addCriticNode,
  addHumanGateNode,
  addTeamNode,
  addMusicNode,
  addRunNode,
  nodes,
  edges,
  flowInstance,
  addAgentNode,
  addSkillsNode,
  addSkillNode,
  spawnBrowserNode,
  spawnStandaloneBrowserNode,
  closeBrowserNode,
  removeNode,
  markNodeLeaving,
  markAllNodesLeaving,
  removeAllNodes,
  patchNodeData,
  focusNode,
  focusNodes,
  revealNodes,
  enterFocusMode,
  dispatchTask,
  convertNoteToTask,
  arrangeNodes,
  commitAgentDraw,
}: CanvasCommandCenterOptions) {
  const agentSpawnBurstRef = useRef({ last: Number.NEGATIVE_INFINITY, count: 0 });

  /**
   * Spawn a node at the viewport centre, fanned out when it lands inside a rapid burst. EVERY create
   * path shares this — a node placed off-screen (the old world-coordinate cascade) is invisible until
   * the debounced auto-tidy drags the camera to it, which is what made voice spawns read as a glitch.
   */
  const nextCenteredSpawnPosition = useCallback(
    (size = AGENT_NODE_SIZE): XYPosition | undefined => {
      const base = centeredSpawnPosition(flowInstance, size);
      if (!base) return undefined;
      const now = performance.now();
      const burst = agentSpawnBurstRef.current;
      burst.count = now - burst.last < AGENT_CENTER_SPAWN_WINDOW_MS ? burst.count + 1 : 0;
      burst.last = now;
      const offset = centerSpawnBurstOffset(size, burst.count);
      return { x: base.x + offset.x, y: base.y + offset.y };
    },
    [flowInstance],
  );

  return useCallback((command: CanvasCommand): CanvasCommandResult => {
    switch (command.kind) {
      case "create-node": {
        // One placement seam for every kind: an explicit `at` wins, otherwise the viewport centre
        // (fanned out within a burst). Only when there is no flow instance does `at` stay undefined
        // and each factory fall back to its own cascade.
        const at = command.at ?? nextCenteredSpawnPosition(canvasNodeSpawnSize(command.nodeType));
        const nodeId = (() => {
          switch (command.nodeType) {
            case "terminal": return command.frameId ? addTerminalNode(at, command.frameId) : addTerminalNode(at);
            case "note": return addNoteNode(at, command.content);
            case "plan": return addPlanNode(at);
            case "task": return addTaskNode(undefined, at);
            case "context": return addContextNode(at);
            case "critic": return addCriticNode(at);
            case "human-gate": return addHumanGateNode(at);
            case "team": return addTeamNode(at);
            case "music": return addMusicNode(at);
          }
        })();
        if (shouldAutoFocusOnCreate(command)) focusNode(nodeId);
        return { nodeId };
      }
      case "create-note-drop-target": {
        const nodeId = addNoteNode(centeredSpawnPosition(flowInstance, DEFAULT_NOTE_SIZE, command.screen), command.content ?? "");
        if (shouldAutoFocusOnCreate(command)) focusNode(nodeId);
        return { nodeId };
      }
      case "create-agent": {
        // Peer-messaging capability is injected into the agent's system prompt at spawn (ADR-0030,
        // live-agent-spawn.ts) — NOT into the task message — so a briefed spawn stays a clean task.
        const agentOptions = command.brief ? { ...command.options, initialTask: command.brief } : command.options;
        const nodeId = addAgentNode(command.definition, command.at ?? nextCenteredSpawnPosition(), agentOptions);
        if (shouldAutoFocusOnCreate(command)) focusNode(nodeId);
        return { nodeId };
      }
      case "create-run": {
        const nodeId = addRunNode(command.memberIds);
        return nodeId ? { nodeId } : { error: "None of the selected nodes can join a run: pick agents, teams, critics or gates that are not in another run." };
      }
      case "create-browser": {
        const nodeId = spawnStandaloneBrowserNode(command.url ?? "about:blank");
        if (shouldAutoFocusOnCreate(command)) focusNode(nodeId);
        return { nodeId };
      }
      case "add-skills": {
        const nodeId = addSkillsNode(command.terminalId, command.cwd);
        // Reveal, don't re-frame: the Skills node opens beside a terminal the user is
        // reading, so the camera should move only as far as it must to show it.
        if (revealNodes) revealNodes(nodeId, [command.terminalId]);
        else focusNodes([command.terminalId, nodeId], nodeId);
        return { nodeId };
      }
      case "open-skill": {
        const nodeId = addSkillNode(command.skill, command.skillsNodeId);
        if (revealNodes) revealNodes(nodeId, [command.skillsNodeId]);
        else focusNodes(deriveSkillPreviewFocusChain(edges, command.skillsNodeId, nodeId), nodeId);
        return { nodeId };
      }
      case "toggle-browser": {
        const browserNode = nodes.find(
          (node) => node.type === "browser" && edges.some((edge) => edge.source === command.terminalId && edge.target === node.id),
        );
        if (browserNode) {
          closeBrowserNode(browserNode.id);
          return { nodeId: browserNode.id };
        }
        const nodeId = spawnBrowserNode(command.terminalId, command.url ?? "about:blank");
        return { nodeId };
      }
      case "open-browser-for-terminal": {
        const plan = planCanvasBrowserControl(
          { kind: "open-or-focus", terminalId: command.terminalId, url: command.url },
          { nodes, edges },
        );
        if (plan.kind === "spawn") {
          return { nodeId: spawnBrowserNode(plan.terminalId, plan.url) };
        }
        if (plan.kind === "focus") {
          focusNode(plan.nodeId);
          return { nodeId: plan.nodeId };
        }
        if (plan.kind === "activate") {
          patchNodeData(plan.nodeId, { url: plan.url, state: "loading" });
          focusNode(plan.nodeId);
          return { nodeId: plan.nodeId };
        }
        if (plan.kind === "navigate") {
          patchNodeData(plan.nodeId, { url: plan.url, state: "active" });
          focusNode(plan.nodeId);
          void navigateCanvasBrowser(plan.nativeBrowserId, plan.url).catch((err: unknown) => {
            console.warn("[canvas-browser-control] navigate failed", err);
          });
          return { nodeId: plan.nodeId };
        }
        // plan.kind === "ignore": the target terminal isn't a node in this project — do nothing.
        return {};
      }
      case "navigate-browser-node": {
        const browserNode = nodes.find((node) => node.id === command.nodeId && node.type === "browser");
        if (!browserNode) {
          console.warn("[canvas-browser-control] browser node not found", command.nodeId);
          return {};
        }
        const dataParentTerminalId =
          typeof browserNode.data?.parentTerminalId === "string" ? browserNode.data.parentTerminalId : null;
        const edgeParentTerminalId = edges.find((edge) => edge.target === command.nodeId)?.source ?? null;
        const { nativeBrowserId } = resolveCanvasBrowserPairIdentity(command.nodeId, dataParentTerminalId ?? edgeParentTerminalId);
        const state = typeof browserNode.data?.state === "string" ? browserNode.data.state : "disconnected";
        patchNodeData(command.nodeId, { url: command.url, state: state === "active" ? "active" : "loading" });
        focusNode(command.nodeId);
        if (state === "active") {
          void navigateCanvasBrowser(nativeBrowserId, command.url).catch((err: unknown) => {
            console.warn("[canvas-browser-control] navigate failed", err);
          });
        }
        return { nodeId: command.nodeId };
      }
      case "patch-node":
        patchNodeData(command.nodeId, command.patch);
        return { nodeId: command.nodeId };
      case "recover-browser":
        patchNodeData(command.nodeId, { state: "loading" });
        focusNode(command.nodeId);
        return { nodeId: command.nodeId };
      case "recover-terminal": {
        const node = nodes.find((candidate) => candidate.id === command.nodeId);
        const oldPaneId = typeof node?.data?.runtimePaneId === "string" ? node.data.runtimePaneId : command.nodeId;
        const runtimeScope = typeof node?.data?.runtimeScope === "string" ? node.data.runtimeScope : "canvas:default";
        const nextPaneId = `${runtimeScope}:${command.nodeId}:recover:${Date.now()}`;
        closeTerminalSession(oldPaneId);
        resetTerminalActivity(oldPaneId);
        patchNodeData(command.nodeId, { runtimePaneId: nextPaneId });
        focusNode(command.nodeId);
        return { nodeId: command.nodeId };
      }
      case "convert-note-to-task":
        convertNoteToTask(command.nodeId, command.draft);
        return { nodeId: command.nodeId };
      case "focus-node":
        (enterFocusMode ?? focusNode)(command.nodeId);
        return { nodeId: command.nodeId };
      case "close-node": {
        // Start cleanup immediately; graph removal also waits for the leave animation (ADR-0033). Skip the delay
        // when motion is off (setting or OS reduced motion) — CSS is silenced there too.
        if (!canvasMotionEnabled()) {
          removeNode(command.nodeId);
        } else {
          markNodeLeaving(command.nodeId);
          removeNode(command.nodeId, CANVAS_MOTION.leaveMs);
        }
        return { nodeId: command.nodeId };
      }
      case "close-all-nodes": {
        // Close-all starts each shutdown now and retains failed nodes. Successful removals
        // also wait for the cascading leave animation.
        // Motion off (setting / OS reduced motion) → clear immediately.
        const totalMs = canvasMotionEnabled() ? markAllNodesLeaving() || 0 : 0;
        if (totalMs <= 0) {
          removeAllNodes();
        } else {
          removeAllNodes(totalMs);
        }
        return {};
      }
      case "arrange-layout":
        arrangeNodes();
        return {};
      case "create-frame":
      case "move-to-frame":
      case "fly-to-frame":
        // Frame state lives in CanvasPage, which intercepts these before the command center.
        return { error: "Frame commands are handled by the canvas page." };
      case "draw-diagram": {
        // Direct draw: the graph was produced inline by the NL parser. The shared orchestrator
        // decides new-vs-edit, places/anchors it, and (for an edit) injects the old diagram's node
        // ids into removeIds so the commit swaps it atomically. A graph that can't lay out returns an
        // error to surface (not silent).
        const application = planDiagramDraw({
          graph: command.graph,
          direction: command.direction,
          title: command.topic,
          nodes,
          edges,
          baseAnchor: centeredSpawnPosition(flowInstance, DIAGRAM_NOMINAL_SIZE) ?? { x: 0, y: 0 },
          makeId: () => crypto.randomUUID(),
          measure: measureDiagramLabel,
        });
        if ("error" in application) return { error: application.error };
        commitAgentDraw(application);
        return {};
      }
      case "dispatch-task":
        dispatchTask(command.nodeId, command.mode, command.runner, command.runnerCommand);
        return { nodeId: command.nodeId };
    }
  }, [
    addAgentNode,
    arrangeNodes,
    addContextNode,
    addSkillNode,
    addSkillsNode,
    addCriticNode,
    addHumanGateNode,
    addMusicNode,
    addRunNode,
    addNoteNode,
    addPlanNode,
    addTaskNode,
    addTeamNode,
    addTerminalNode,
    closeBrowserNode,
    convertNoteToTask,
    dispatchTask,
    edges,
    flowInstance,
    focusNode,
    focusNodes,
    revealNodes,
    enterFocusMode,
    nextCenteredSpawnPosition,
    nodes,
    patchNodeData,
    removeNode,
    markNodeLeaving,
    markAllNodesLeaving,
    removeAllNodes,
    spawnBrowserNode,
    spawnStandaloneBrowserNode,
    commitAgentDraw,
  ]);
}
