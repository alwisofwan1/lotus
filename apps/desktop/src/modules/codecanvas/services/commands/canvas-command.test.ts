import { describe, expect, it } from "vitest";
import type { CanvasSkillPreview, SmartConvertDraft } from "../../types/canvas";
import {
  canvasCommandTargetNodeId,
  isCanvasCreateCommand,
  shouldFocusCanvasCommandResult,
  type CanvasCommand,
} from "./canvas-command";

const skillPreview: CanvasSkillPreview = {
  name: "ship",
  source: "global",
  content: "Ship",
  description: "Ship",
  path: "/skills/ship.md",
};

const draft: SmartConvertDraft = {
  title: "Task",
  intent: "ship",
  taskClass: "quick",
  when: "urgent",
  acceptanceCriteria: [],
  subtasks: [],
};

describe("canvas command contract", () => {
  it("identifies create commands", () => {
    expect(isCanvasCreateCommand({ kind: "create-node", nodeType: "note" })).toBe(true);
    expect(isCanvasCreateCommand({ kind: "create-browser" })).toBe(true);
    expect(isCanvasCreateCommand({ kind: "focus-node", nodeId: "n1" })).toBe(false);
  });

  it("extracts target ids for commands that operate on existing nodes", () => {
    expect(canvasCommandTargetNodeId({ kind: "focus-node", nodeId: "n1" })).toBe("n1");
    expect(canvasCommandTargetNodeId({ kind: "close-node", nodeId: "n2" })).toBe("n2");
    expect(canvasCommandTargetNodeId({ kind: "dispatch-task", nodeId: "task-1", mode: "single" })).toBe("task-1");
    expect(canvasCommandTargetNodeId({ kind: "add-skills", terminalId: "term-1", cwd: "/repo" })).toBe("term-1");
    expect(canvasCommandTargetNodeId({ kind: "open-skill", skillsNodeId: "skills-1", skill: skillPreview })).toBe("skills-1");
    expect(canvasCommandTargetNodeId({ kind: "open-browser-for-terminal", terminalId: "term-2" })).toBe("term-2");
    expect(canvasCommandTargetNodeId({ kind: "toggle-browser", terminalId: "term-2" })).toBe("term-2");
    expect(canvasCommandTargetNodeId({ kind: "patch-node", nodeId: "node-3", patch: { title: "Updated" } })).toBe("node-3");
    expect(canvasCommandTargetNodeId({ kind: "recover-browser", nodeId: "browser-1" })).toBe("browser-1");
    expect(canvasCommandTargetNodeId({ kind: "recover-terminal", nodeId: "term-1" })).toBe("term-1");
    expect(canvasCommandTargetNodeId({ kind: "convert-note-to-task", nodeId: "note-1", draft })).toBe("note-1");
    expect(canvasCommandTargetNodeId({ kind: "create-note-drop-target", screen: { x: 1, y: 2 } })).toBeNull();
    expect(canvasCommandTargetNodeId({ kind: "create-node", nodeType: "terminal" })).toBeNull();
  });

  it("focuses new command results unless explicitly disabled", () => {
    const createNote: CanvasCommand = { kind: "create-node", nodeType: "note" };
    const createBrowserNoFocus: CanvasCommand = { kind: "create-browser", focus: false };
    const createDropTarget: CanvasCommand = { kind: "create-note-drop-target" };

    expect(shouldFocusCanvasCommandResult(createNote)).toBe(true);
    expect(shouldFocusCanvasCommandResult(createDropTarget)).toBe(true);
    expect(shouldFocusCanvasCommandResult(createBrowserNoFocus)).toBe(false);
    expect(shouldFocusCanvasCommandResult({ kind: "focus-node", nodeId: "n1" })).toBe(false);
  });
});
