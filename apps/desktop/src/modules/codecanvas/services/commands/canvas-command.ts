import type { XYPosition } from "@xyflow/react";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { AgentDefinition, CanvasSkillPreview, SmartConvertDraft, TaskDispatchMode } from "../../types/canvas";
import type { DiagramGraph } from "../agent-draw/diagram-layout";

export const CANVAS_CREATE_NODE_KINDS = [
  "terminal",
  "note",
  "plan",
  "task",
  "context",
  "critic",
  "human-gate",
  "team",
  "music",
] as const;

export type CanvasCreateNodeKind = (typeof CANVAS_CREATE_NODE_KINDS)[number];

/** The Lotus task an agent spawned a cell for; stamped on the node (decision 26). */
export interface SpawnTaskStamp {
  key: string;
  title?: string;
}

export type CanvasCommand =
  | { kind: "create-node"; nodeType: CanvasCreateNodeKind; at?: XYPosition; content?: string; focus?: boolean; /** Spawn straight into this Frame (terminals). */ frameId?: string }
  | { kind: "create-note-drop-target"; screen?: XYPosition; content?: string; focus?: boolean }
  | { kind: "create-agent"; definition: AgentDefinition; at?: XYPosition; options?: { isolate?: boolean; teamLabel?: string; frameId?: string; spawnTask?: SpawnTaskStamp; account?: string }; brief?: string; focus?: boolean }
  | { kind: "create-browser"; url?: string; focus?: boolean }
  /** A Run Node owning `memberIds` (plans/canvas-graph-run). Ids another run owns are skipped. */
  | { kind: "create-run"; memberIds: string[] }
  | { kind: "add-skills"; terminalId: string; cwd: string }
  | { kind: "open-skill"; skillsNodeId: string; skill: CanvasSkillPreview }
  | { kind: "open-browser-for-terminal"; terminalId: string; url?: string }
  | { kind: "navigate-browser-node"; nodeId: string; url: string }
  | { kind: "toggle-browser"; terminalId: string; url?: string }
  | { kind: "patch-node"; nodeId: string; patch: Record<string, unknown> }
  | { kind: "recover-browser"; nodeId: string }
  | { kind: "recover-terminal"; nodeId: string }
  | { kind: "convert-note-to-task"; nodeId: string; draft: SmartConvertDraft }
  | { kind: "focus-node"; nodeId: string }
  | { kind: "close-node"; nodeId: string }
  | { kind: "close-all-nodes" }
  | { kind: "arrange-layout" }
  /** A Frame around these nodes (NL bar, LOT2-129). `title` omitted = auto name. */
  | { kind: "create-frame"; nodeIds: string[]; title?: string }
  /** Put nodes into a Frame; `frameId` undefined takes them out, leaving them loose. */
  | { kind: "move-to-frame"; nodeIds: string[]; frameId: string | undefined }
  | { kind: "fly-to-frame"; frameId: string }
  | { kind: "draw-diagram"; topic: string; graph: DiagramGraph; diagramType?: string; direction?: "TB" | "LR" }
  | { kind: "dispatch-task"; nodeId: string; mode: TaskDispatchMode; runner?: AgentRunnerType; runnerCommand?: string };

export interface CanvasCommandResult {
  nodeId?: string;
  /** Set when a command ran but could not complete (e.g. a diagram graph that failed to lay out),
   *  so the caller can surface it instead of the command failing silently. */
  error?: string;
}

export function canvasCommandTargetNodeId(command: CanvasCommand): string | null {
  switch (command.kind) {
    case "focus-node":
    case "close-node":
    case "dispatch-task":
    case "patch-node":
    case "recover-browser":
    case "recover-terminal":
    case "convert-note-to-task":
    case "navigate-browser-node":
      return command.nodeId;
    case "add-skills":
    case "open-browser-for-terminal":
    case "toggle-browser":
      return command.terminalId;
    case "open-skill":
      return command.skillsNodeId;
    case "create-node":
    case "create-note-drop-target":
    case "create-agent":
    case "create-browser":
    case "create-run":
    case "arrange-layout":
    case "create-frame":
    case "move-to-frame":
    case "fly-to-frame":
    case "close-all-nodes":
    case "draw-diagram":
      return null;
  }
}

export type CanvasCreateCommand = Extract<CanvasCommand, { focus?: boolean }>;

export function isCanvasCreateCommand(command: CanvasCommand): command is CanvasCreateCommand {
  return command.kind === "create-node" || command.kind === "create-note-drop-target" || command.kind === "create-agent" || command.kind === "create-browser";
}

export function shouldFocusCanvasCommandResult(command: CanvasCommand): boolean {
  if (!isCanvasCreateCommand(command)) return false;
  return command.focus !== false;
}
