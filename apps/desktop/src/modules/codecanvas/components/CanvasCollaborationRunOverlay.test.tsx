import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasCollaborationRunOverlay } from "./CanvasCollaborationRunOverlay";
import type { BridgeTask } from "@/lib/tauri-api";

const task: BridgeTask = {
  id: "task_bug_123",
  workspaceId: "ws-1",
  title: "Fix paste crash",
  goal: "Pasting an image crashes the note editor.",
  knowledge: "Repro steps here",
  status: "in-progress",
  priority: "high",
  assignees: ["Rowan", "Mira"],
  createdAt: 100,
  updatedAt: 200,
  feedbackEvents: [
    { id: "ev_old", at: 1000, actor: "director", kind: "intake-created", summary: "Intake complete" },
    { id: "ev_new", at: 2000, actor: "agent", kind: "agent-result", summary: "Mira produced evidence" },
  ],
};

describe("CanvasCollaborationRunOverlay", () => {
  it("renders nothing when collaboration launch mode is off", () => {
    const { container } = render(<CanvasCollaborationRunOverlay launch={{ mode: "off" }} participants={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a task-triggered collaboration ledger without requiring a terminal node", () => {
    render(
      <CanvasCollaborationRunOverlay
        launch={{
          mode: "swarm-task",
          sourceLabel: "Swarm task",
          taskId: "task_bug_123",
          workflowId: "wf-feature-pipeline",
          autoOpenPanel: true,
        }}
        participants={[{ id: "agent-1", name: "Rowan Lead", status: "running", source: "canvas-agent", evidenceCount: 0 }]}
      />,
    );

    expect(screen.getByRole("complementary", { name: /collaboration ledger/i })).toHaveTextContent("task_bug_123");
    expect(screen.getByRole("complementary", { name: /collaboration ledger/i })).toHaveTextContent("Rowan Lead");
    expect(screen.getByRole("button", { name: /toggle collaboration ledger/i })).toHaveTextContent("Swarm task");
  });

  it("renders projected participant states including missing assignees and evidence", () => {
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[
          { id: "assignee:ilya", name: "Ilya", status: "not-spawned", source: "task-assignee", evidenceCount: 0 },
          { id: "node-mira", name: "Mira", status: "done", source: "task-assignee", evidenceCount: 2, lastEventSummary: "Mira produced evidence" },
        ]}
        task={task}
      />,
    );

    const panel = screen.getByRole("complementary", { name: /collaboration ledger/i });
    expect(panel).toHaveTextContent("Ilya");
    expect(panel).toHaveTextContent("Not spawned");
    expect(panel).toHaveTextContent("Mira produced evidence");
    expect(panel).toHaveTextContent("2 evidence");
  });

  it("renders real Swarm task details and latest feedback timeline events", () => {
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[]}
        task={task}
      />,
    );

    const panel = screen.getByRole("complementary", { name: /collaboration ledger/i });
    expect(panel).toHaveTextContent("Fix paste crash");
    expect(panel).toHaveTextContent("In progress");
    expect(panel).toHaveTextContent("High");
    expect(panel).toHaveTextContent("Rowan");
    expect(panel).toHaveTextContent("Mira produced evidence");
    expect(panel).toHaveTextContent("Intake complete");
  });

  it("shows copyable MCP context when project-backed collaboration ids are available", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[]}
        task={task}
        projectId="project-1"
        runId="swarm-task:task:task_bug_123"
      />,
    );

    const panel = screen.getByRole("complementary", { name: /collaboration ledger/i });
    expect(panel).toHaveTextContent("MCP context");
    expect(panel).toHaveTextContent("project-1");
    expect(panel).toHaveTextContent("swarm-task:task:task_bug_123");

    fireEvent.click(screen.getByRole("button", { name: /copy mcp context/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("lotus_canvas_read_assignment"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("project-1"));
  });

  it("shows collaboration storage freshness and source", () => {
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[]}
        task={task}
        storageStatus="mcp-updated"
      />,
    );

    const panel = screen.getByRole("complementary", { name: /collaboration ledger/i });
    expect(panel).toHaveTextContent("Updated by MCP");
  });

  it("shows recent durable mailbox messages and evidence metadata", () => {
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[]}
        task={task}
        mailboxMessages={[
          { id: "msg-1", assignee: "Mira", assigneeKey: "mira", nodeId: "node-mira", kind: "handoff", author: "director", body: "Initial task brief", createdAt: 100 },
          { id: "ev-1", assignee: "Mira", assigneeKey: "mira", nodeId: "node-mira", kind: "evidence", author: "agent", body: "Fixed paste crash", createdAt: 200, evidence: { files: ["src/editor.ts"], checks: ["bun test editor"] } },
        ]}
      />,
    );

    const panel = screen.getByRole("complementary", { name: /collaboration ledger/i });
    expect(panel).toHaveTextContent("Assignment mailbox");
    expect(panel).toHaveTextContent("Fixed paste crash");
    expect(panel).toHaveTextContent("src/editor.ts");
    expect(panel).toHaveTextContent("bun test editor");
    expect(panel).toHaveTextContent("Initial task brief");
  });

  it("expands participant detail threads with assignee mailbox history", () => {
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[
          { id: "node-mira", nodeId: "node-mira", name: "Mira", status: "running", source: "task-assignee", evidenceCount: 1 },
          { id: "node-rowan", nodeId: "node-rowan", name: "Rowan", status: "queued", source: "task-assignee", evidenceCount: 0 },
        ]}
        task={task}
        mailboxMessages={[
          { id: "mira-handoff", assignee: "Mira", assigneeKey: "mira", nodeId: "node-mira", kind: "handoff", author: "director", body: "Mira brief", createdAt: 100 },
          { id: "mira-evidence", assignee: "Mira", assigneeKey: "mira", nodeId: "node-mira", kind: "evidence", author: "agent", body: "Mira proof", createdAt: 200, evidence: { files: ["src/mira.ts"] } },
          { id: "rowan-note", assignee: "Rowan", assigneeKey: "rowan", nodeId: "node-rowan", kind: "note", author: "human", body: "Rowan note", createdAt: 300 },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /show mira details/i }));

    const thread = screen.getByRole("region", { name: /mira assignment thread/i });
    expect(thread).toHaveTextContent("Mira proof");
    expect(thread).toHaveTextContent("src/mira.ts");
    expect(thread).toHaveTextContent("Mira brief");
    expect(thread).not.toHaveTextContent("Rowan note");
  });

  it("records manual evidence and blockers from participant details", () => {
    const onRecordEvidence = vi.fn();
    const onMarkBlocked = vi.fn();
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[{ id: "node-mira", nodeId: "node-mira", name: "Mira", status: "running", source: "task-assignee", evidenceCount: 0 }]}
        task={task}
        onRecordEvidence={onRecordEvidence}
        onMarkBlocked={onMarkBlocked}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /show mira details/i }));
    fireEvent.click(screen.getByRole("button", { name: /record evidence for mira/i }));
    fireEvent.change(screen.getByLabelText(/evidence summary/i), { target: { value: "Regression added" } });
    fireEvent.change(screen.getByLabelText(/files touched/i), { target: { value: "src/editor.ts, src/editor.test.ts" } });
    fireEvent.change(screen.getByLabelText(/checks run/i), { target: { value: "bun test editor" } });
    fireEvent.click(screen.getByRole("button", { name: /^save evidence$/i }));

    expect(onRecordEvidence).toHaveBeenCalledWith({
      assignee: "Mira",
      nodeId: "node-mira",
      summary: "Regression added",
      files: ["src/editor.ts", "src/editor.test.ts"],
      checks: ["bun test editor"],
    });

    fireEvent.click(screen.getByRole("button", { name: /mark mira blocked/i }));
    fireEvent.change(screen.getByLabelText(/blocker summary/i), { target: { value: "Needs QA device" } });
    fireEvent.change(screen.getByLabelText(/blocker details/i), { target: { value: "missing macOS paste fixture" } });
    fireEvent.click(screen.getByRole("button", { name: /^save blocker$/i }));

    expect(onMarkBlocked).toHaveBeenCalledWith({
      assignee: "Mira",
      nodeId: "node-mira",
      summary: "Needs QA device",
      blockers: ["missing macOS paste fixture"],
    });
  });

  it("shows ledger state chips for participants with durable assignment state", () => {
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[
          { id: "node-mira", nodeId: "node-mira", name: "Mira", status: "running", source: "task-assignee", evidenceCount: 0, assignmentState: "running", assignmentBriefSent: true },
        ]}
        task={task}
      />,
    );

    const panel = screen.getByRole("complementary", { name: /collaboration ledger/i });
    expect(panel).toHaveTextContent("Ledger: Running");
    expect(panel).toHaveTextContent("Brief sent");
  });

  it("offers focus actions for participants backed by Canvas agent nodes", () => {
    const onFocusParticipant = vi.fn();
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[
          { id: "node-mira", nodeId: "node-mira", name: "Mira", status: "running", source: "task-assignee", evidenceCount: 0 },
          { id: "assignee:ilya", name: "Ilya", status: "not-spawned", source: "task-assignee", evidenceCount: 0 },
        ]}
        task={task}
        onFocusParticipant={onFocusParticipant}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /focus mira/i }));

    expect(onFocusParticipant).toHaveBeenCalledWith("node-mira");
    expect(screen.queryByRole("button", { name: /focus ilya/i })).not.toBeInTheDocument();
  });

  it("offers a spawn action when task assignees are missing from the canvas", () => {
    const onSpawnMissing = vi.fn();
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_bug_123", workspaceId: "ws-1", workflowId: "wf-feature-pipeline", autoOpenPanel: true }}
        participants={[{ id: "assignee:ilya", name: "Ilya", status: "not-spawned", source: "task-assignee", evidenceCount: 0 }]}
        task={task}
        onSpawnMissing={onSpawnMissing}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /spawn missing agents/i }));

    expect(onSpawnMissing).toHaveBeenCalledTimes(1);
  });

  it("lets users collapse the panel so the canvas can stay clean", () => {
    render(
      <CanvasCollaborationRunOverlay
        launch={{ mode: "swarm-workflow", sourceLabel: "Swarm workflow", workflowId: "wf-release", autoOpenPanel: true }}
        participants={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /close collaboration ledger/i }));

    expect(screen.queryByRole("complementary", { name: /collaboration ledger/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /toggle collaboration ledger/i })).toHaveTextContent("Swarm workflow");
  });
});
