import { describe, expect, it, vi } from "vitest";
import type { SmartConvertDraft } from "../../types/canvas";
import { handleCanvasNodeCommand } from "./canvas-node-command";

function handlers() {
  return {
    closeNode: vi.fn(),
    changeNote: vi.fn(),
    convertNote: vi.fn(),
    patchNote: vi.fn(),
    spawnAgentForNote: vi.fn(),
    patchBrowser: vi.fn(),
    patchContext: vi.fn(),
    patchCritic: vi.fn(),
    patchHumanGate: vi.fn(),
    patchMusic: vi.fn(),
    patchFile: vi.fn(),
    patchPlan: vi.fn(),
    patchRun: vi.fn(),
    patchTask: vi.fn(),
    patchTeam: vi.fn(),
    patchTerminal: vi.fn(),
    patchShape: vi.fn(),
    recoverTerminal: vi.fn(),
    addAgentSkills: vi.fn(),
    renameAgent: vi.fn(),
    promoteAgentToTerminal: vi.fn(),
    openSkill: vi.fn(),
    applySkill: vi.fn(),
    reenableSkill: vi.fn(),
    addTerminalSkills: vi.fn(),
    spawnTerminalForWorktree: vi.fn(),
    toggleBrowser: vi.fn(),
    dispatchTask: vi.fn(),
    launchTeam: vi.fn(),
    focusNode: vi.fn(),
  };
}

describe("handleCanvasNodeCommand", () => {
  it("routes patch-file commands to the patchFile handler", () => {
    const h = handlers();
    handleCanvasNodeCommand({ kind: "patch-file", nodeId: "f1", patch: { viewport: { topLine: 9 } } }, h);
    expect(h.patchFile).toHaveBeenCalledWith("f1", { viewport: { topLine: 9 } });
  });

  it("routes note-spawn-agent commands to the spawnAgentForNote handler", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "note-spawn-agent", nodeId: "note-1" }, h);

    expect(h.spawnAgentForNote).toHaveBeenCalledWith("note-1");
    expect(h.patchNote).not.toHaveBeenCalled();
  });

  it("routes patch-note commands (the note cover) to the patchNote handler", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-note", nodeId: "note-1", patch: { coverUri: null } }, h);

    expect(h.patchNote).toHaveBeenCalledWith("note-1", { coverUri: null });
    expect(h.changeNote).not.toHaveBeenCalled();
  });

  it("routes rename-agent commands to the renameAgent handler", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "rename-agent", agentId: "agent-1", name: "Atlas" }, h);

    expect(h.renameAgent).toHaveBeenCalledWith("agent-1", "Atlas");
    expect(h.closeNode).not.toHaveBeenCalled();
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("routes close-node commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "close-node", nodeId: "task-1" }, h);

    expect(h.closeNode).toHaveBeenCalledWith("task-1");
    expect(h.patchTask).not.toHaveBeenCalled();
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("routes focus-node commands to the focusNode handler", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "focus-node", nodeId: "agent-1" }, h);

    expect(h.focusNode).toHaveBeenCalledWith("agent-1");
    expect(h.closeNode).not.toHaveBeenCalled();
  });

  it("routes note change commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "note-change", nodeId: "note-1", content: "hello" }, h);

    expect(h.changeNote).toHaveBeenCalledWith("note-1", "hello");
  });

  it("routes note conversion commands", () => {
    const h = handlers();
    const draft: SmartConvertDraft = { title: "Task", intent: "Ship", acceptanceCriteria: [], taskClass: "quick", when: "whenever", subtasks: [] };

    handleCanvasNodeCommand({ kind: "note-convert", nodeId: "note-1", draft }, h);

    expect(h.convertNote).toHaveBeenCalledWith("note-1", draft);
  });

  it("routes browser patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-browser", nodeId: "browser-1", patch: { url: "https://example.com" } }, h);

    expect(h.patchBrowser).toHaveBeenCalledWith("browser-1", { url: "https://example.com" });
  });

  it("routes context patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-context", nodeId: "context-1", patch: { title: "Findings" } }, h);

    expect(h.patchContext).toHaveBeenCalledWith("context-1", { title: "Findings" });
  });

  it("routes critic patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-critic", nodeId: "critic-1", patch: { title: "Verifier" } }, h);

    expect(h.patchCritic).toHaveBeenCalledWith("critic-1", { title: "Verifier" });
  });

  it("routes human gate patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-human-gate", nodeId: "gate-1", patch: { status: "approved" } }, h);

    expect(h.patchHumanGate).toHaveBeenCalledWith("gate-1", { status: "approved" });
  });

  it("routes plan patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-plan", nodeId: "plan-1", patch: { title: "Plan B" } }, h);

    expect(h.patchPlan).toHaveBeenCalledWith("plan-1", { title: "Plan B" });
  });

  it("routes run patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-run", nodeId: "run-1", patch: { brief: "Ship the fix" } }, h);

    expect(h.patchRun).toHaveBeenCalledWith("run-1", { brief: "Ship the fix" });
  });

  it("routes task patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-task", nodeId: "task-1", patch: { title: "Ship it" } }, h);

    expect(h.patchTask).toHaveBeenCalledWith("task-1", { title: "Ship it" });
  });

  it("routes team patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-team", nodeId: "team-1", patch: { goal: "Ship" } }, h);

    expect(h.patchTeam).toHaveBeenCalledWith("team-1", { goal: "Ship" });
  });

  it("routes agent skill commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "agent-add-skills", agentId: "agent-1", cwd: "/repo" }, h);

    expect(h.addAgentSkills).toHaveBeenCalledWith("agent-1", "/repo");
  });

  it("routes agent terminal promotion commands", () => {
    const h = handlers();
    const payload = { name: "Coder", model: "claude", rolePrompt: "Code", runCwd: "/repo", appliedSkills: [], context: [], roster: [] };

    handleCanvasNodeCommand({ kind: "agent-promote-to-terminal", agentId: "agent-1", payload }, h);

    expect(h.promoteAgentToTerminal).toHaveBeenCalledWith("agent-1", payload);
  });

  it("routes open skill commands", () => {
    const h = handlers();
    const skill = { name: "ship", source: "project", content: "# Ship" } as const;

    handleCanvasNodeCommand({ kind: "open-skill", skillsNodeId: "skills-1", skill }, h);

    expect(h.openSkill).toHaveBeenCalledWith("skills-1", skill);
  });

  it("routes apply skill commands — the drag-free apply path", () => {
    const h = handlers();
    const skill = { name: "ship", source: "project", content: "# Ship" } as const;

    handleCanvasNodeCommand({ kind: "apply-skill", targetId: "term-1", skill }, h);

    expect(h.applySkill).toHaveBeenCalledWith("term-1", skill);
    expect(h.openSkill).not.toHaveBeenCalled();
  });

  it("routes re-enable skill commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "reenable-skill", terminalId: "term-1", skillName: "ship" }, h);

    expect(h.reenableSkill).toHaveBeenCalledWith("term-1", "ship");
  });

  it("routes terminal patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-terminal", nodeId: "term-1", patch: { cwd: "/repo" } }, h);

    expect(h.patchTerminal).toHaveBeenCalledWith("term-1", { cwd: "/repo" });
  });

  it("routes terminal recovery commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "recover-terminal", nodeId: "term-1" }, h);

    expect(h.recoverTerminal).toHaveBeenCalledWith("term-1");
  });

  it("routes terminal skill commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "terminal-add-skills", terminalId: "term-1", cwd: "/repo" }, h);

    expect(h.addTerminalSkills).toHaveBeenCalledWith("term-1", "/repo");
  });

  it("routes terminal worktree spawn commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "terminal-spawn-for-worktree", terminalId: "term-1", branch: "feature/demo", path: "/repo/wt" }, h);

    expect(h.spawnTerminalForWorktree).toHaveBeenCalledWith("term-1", "feature/demo", "/repo/wt");
  });

  it("routes browser toggle commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "toggle-browser", terminalId: "term-1" }, h);

    expect(h.toggleBrowser).toHaveBeenCalledWith("term-1");
  });

  it("routes shape patch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "patch-shape", nodeId: "shape-1", patch: { text: "hello" } }, h);

    expect(h.patchShape).toHaveBeenCalledWith("shape-1", { text: "hello" });
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("routes task dispatch commands", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "dispatch-task", nodeId: "task-1", mode: "team" }, h);

    expect(h.dispatchTask).toHaveBeenCalledWith("task-1", "team", undefined, undefined);
  });

  it("routes launch-team commands (ADR-0027 Phase 6)", () => {
    const h = handlers();

    handleCanvasNodeCommand({ kind: "launch-team", nodeId: "team-1" }, h);

    expect(h.launchTeam).toHaveBeenCalledWith("team-1");
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });
});
