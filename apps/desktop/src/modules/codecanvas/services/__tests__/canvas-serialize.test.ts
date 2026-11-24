import { describe, it, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import { toCanvasSnapshot } from "../canvas-serialize";
import { decodeCanvasSnapshot } from "../canvas-snapshot-codec";
import { agentRecordToNode } from "../canvas-agent-node";
import type { CanvasAgentNodeRecord } from "../../types/canvas";
import { terminalNode } from "../canvas-node-factory";

const nodes: Node[] = [
  { id: "term-1", type: "terminal", position: { x: 0, y: 0 }, width: 560, height: 360,
    data: { cwd: "/app", terminalNumber: 2, assignedWorktree: "feature/x" } },
  { id: "note-1", type: "note", position: { x: 100, y: 100 }, width: 300, height: 200, data: { content: "ignored" } },
  { id: "skills-1", type: "skills", position: { x: 600, y: 0 }, width: 320, height: 380,
    data: { parentTerminalId: "term-1", cwd: "/app" } },
  { id: "skill-1", type: "skill", position: { x: 980, y: 0 }, width: 420, height: 360,
    data: { skillName: "ship", source: "project", content: "# Ship" } },
];
const edges: Edge[] = [
  { id: "e-skills", source: "term-1", target: "skills-1", animated: true },
  { id: "e-skill", source: "skills-1", target: "skill-1", animated: true },
  { id: "e-keep", source: "term-1", target: "note-1" },
];

describe("toCanvasSnapshot", () => {
  /// Reopened, it would relaunch the agent and ask for the work again (S4b); Code drops its own too.
  it("does not write a delegated terminal's launch command", () => {
    const launched = terminalNode({
      id: "term-9", cwd: "/app", terminalNumber: 9, position: { x: 0, y: 0 }, activeProjectId: null,
      launchCommand: ["claude", "--session-id", "s1"], spawnTaskKey: "t1",
    });
    expect(launched.data).toMatchObject({ launchCommand: ["claude", "--session-id", "s1"] });
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: [launched], edges: [], noteContent: new Map() });
    expect(JSON.stringify(snap.nodes[0])).not.toContain("launchCommand");
  });

  it("excludes Skills/Skill nodes and any edge touching one", () => {
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges, noteContent: new Map([["note-1", "checklist"]]) });
    expect(snap.nodes.map((n) => n.id).sort()).toEqual(["note-1", "term-1"]);
    expect(snap.edges.map((e) => e.id)).toEqual(["e-keep"]);
  });

  it("persists a semantic edge kind from the edge data", () => {
    const semanticEdges: Edge[] = [
      { id: "e-trig", source: "a1", target: "a2", data: { wireKind: "triggers" } },
      { id: "e-context", source: "note-1", target: "agent-1", data: { wireKind: "context" } },
      { id: "e-plain", source: "term-1", target: "note-1" },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: semanticEdges, noteContent: new Map() });
    expect(snap.edges.find((e) => e.id === "e-trig")?.kind).toBe("triggers");
    expect(snap.edges.find((e) => e.id === "e-context")?.kind).toBe("context");
    expect(snap.edges.find((e) => e.id === "e-plain")?.kind).toBeUndefined();
  });

  it("persists the connected handle sides when present", () => {
    const handleEdges: Edge[] = [
      { id: "e-h", source: "term-1", target: "note-1", sourceHandle: "wire-bottom", targetHandle: "wire-top" },
      { id: "e-nohandle", source: "term-1", target: "note-1" },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: handleEdges, noteContent: new Map() });
    expect(snap.edges.find((e) => e.id === "e-h")).toMatchObject({ sourceHandle: "wire-bottom", targetHandle: "wire-top" });
    expect(snap.edges.find((e) => e.id === "e-nohandle")?.sourceHandle).toBeUndefined();
  });

  it("serializes browser viewport preferences", () => {
    const browserNodes: Node[] = [
      {
        id: "browser-1",
        type: "browser",
        position: { x: 10, y: 20 },
        width: 420,
        height: 560,
        data: {
          parentTerminalId: "term-1",
          url: "https://example.com",
          browserNumber: 2,
          label: "Preview",
          viewportMode: "mobile",
          viewportOrientation: "portrait",
          viewportWidth: 390,
          viewportHeight: 844,
          viewportScaleMode: "fit",
          viewportZoom: 0.75,
        },
      },
    ];

    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: browserNodes, edges: [], noteContent: new Map() });

    expect(snap.nodes.find((n) => n.id === "browser-1")).toMatchObject({
      type: "browser",
      parentTerminalId: "term-1",
      label: "Preview",
      viewportMode: "mobile",
      viewportOrientation: "portrait",
      viewportWidth: 390,
      viewportHeight: 844,
      viewportScaleMode: "fit",
      viewportZoom: 0.75,
    });
  });

  it("serializes a shape node's kind, style, areaLabel, and threads shapeCounter", () => {
    const shapeNodes: Node[] = [
      { id: "shape-1", type: "shape", position: { x: 10, y: 20 }, width: 200, height: 140,
        data: { shape: "ellipse", areaLabel: "checkout flow", style: { strokeColor: "#fff", opacity: 90 }, shapeNumber: 3 } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: shapeNodes, edges: [], noteContent: new Map(), shapeCounter: 5 });
    expect(snap.shapeCounter).toBe(5);
    expect(snap.nodes.find((n) => n.id === "shape-1")).toMatchObject({
      type: "shape", shape: "ellipse", areaLabel: "checkout flow", style: { strokeColor: "#fff", opacity: 90 }, shapeNumber: 3,
    });
  });

  it("serializes an image shape's asset URI + intrinsic size so GC keeps the asset and reload restores it", () => {
    const shapeNodes: Node[] = [
      { id: "img-1", type: "shape", position: { x: 5, y: 6 }, width: 480, height: 270,
        data: { shape: "image", imageAssetUri: "lotus-note-asset://asset_abc", imageAlt: "shot", imageNaturalWidth: 1600, imageNaturalHeight: 900 } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: shapeNodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "img-1")).toMatchObject({
      type: "shape", shape: "image",
      imageAssetUri: "lotus-note-asset://asset_abc", imageAlt: "shot",
      imageNaturalWidth: 1600, imageNaturalHeight: 900,
    });
    // The asset URI must appear verbatim in the serialized snapshot — that substring is what the
    // Rust note-asset GC scans to know the asset is still referenced.
    expect(JSON.stringify(snap)).toContain("lotus-note-asset://asset_abc");
  });

  it("no longer writes legacy groupIds; membership is the frame reference", () => {
    const shapeNodes: Node[] = [
      { id: "g-1", type: "shape", position: { x: 0, y: 0 }, width: 100, height: 100, data: { shape: "rectangle", groupIds: ["grp-1"], frameId: "fr-1" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: shapeNodes, edges: [], noteContent: new Map() });
    expect(snap.nodes[0]).not.toHaveProperty("groupIds");
    expect(snap.nodes[0]).toMatchObject({ frameId: "fr-1" });
  });

  it("serializes a terminal node's cwd, terminalNumber, and assignedWorktree", () => {
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges, noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "term-1")).toMatchObject({
      type: "terminal", cwd: "/app", terminalNumber: 2, assignedWorktree: "feature/x", size: { w: 560, h: 360 },
    });
  });

  it("persists a custom terminal label", () => {
    const labelled: Node[] = [
      { id: "term-api", type: "terminal", position: { x: 0, y: 0 }, width: 560, height: 360,
        data: { cwd: "/app", terminalNumber: 2, label: "API server", assignedWorktree: null } },
    ];

    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: labelled, edges: [], noteContent: new Map() });

    expect(snap.nodes[0]).toMatchObject({ type: "terminal", label: "API server" });
  });

  it("serializes a terminal node's assignedWorktreePath alongside the branch", () => {
    const withPath: Node[] = [
      { id: "term-p", type: "terminal", position: { x: 0, y: 0 }, width: 560, height: 360,
        data: { cwd: "/app", terminalNumber: 1, assignedWorktree: "feat/ui", assignedWorktreePath: "/app-wt/feat-ui" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: withPath, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "term-p")).toMatchObject({
      assignedWorktree: "feat/ui",
      assignedWorktreePath: "/app-wt/feat-ui",
    });
  });

  it("serializes null assignedWorktreePath when no worktree is assigned", () => {
    const noWt: Node[] = [
      { id: "term-nwt", type: "terminal", position: { x: 0, y: 0 }, width: 560, height: 360,
        data: { cwd: "/app", terminalNumber: 1, assignedWorktree: null } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: noWt, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "term-nwt")).toMatchObject({
      assignedWorktree: null, assignedWorktreePath: null,
    });
  });

  it("serializes a terminal node's baseBranch alongside the worktree (ADR 0015)", () => {
    const withBase: Node[] = [
      { id: "term-b", type: "terminal", position: { x: 0, y: 0 }, width: 560, height: 360,
        data: { cwd: "/app", terminalNumber: 1, assignedWorktree: "lotus/t/a", assignedWorktreePath: "/x/.lotus-worktrees/t/a", baseBranch: "main" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: withBase, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "term-b")).toMatchObject({ baseBranch: "main" });
  });

  it("serializes an agent node's baseBranch with its assigned worktree (ADR 0015)", () => {
    const agent: Node[] = [
      { id: "agent-b", type: "agent", position: { x: 0, y: 0 }, width: 300, height: 240,
        data: { agentDefId: "d", name: "A", model: "m", prompt: "p", cwd: "/app", agentNumber: 1, assignedWorktree: "lotus/t/a", assignedWorktreePath: "/x/.lotus-worktrees/t/a", baseBranch: "main" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: agent, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "agent-b")).toMatchObject({
      assignedWorktree: "lotus/t/a", baseBranch: "main",
    });
  });

  it("serializes an agent node's assigned worktree when present", () => {
    const agentWithWt: Node[] = [
      { id: "agent-wt", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "def-1", name: "Dev", model: "claude-sonnet-4-6", prompt: "go", cwd: "/app", agentNumber: 1,
          assignedWorktree: "feat/api", assignedWorktreePath: "/app-wt/feat-api" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: agentWithWt, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "agent-wt")).toMatchObject({
      assignedWorktree: "feat/api", assignedWorktreePath: "/app-wt/feat-api",
    });
  });

  it("serializes an agent node's resumeSessionId, omitting it when absent (ADR-0027 Phase 5)", () => {
    const nodes: Node[] = [
      { id: "agent-resume", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "d", name: "A", model: "m", prompt: "p", cwd: "/app", agentNumber: 1, runner: "claude", resumeSessionId: "sess-77" } },
      { id: "agent-fresh", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "d", name: "B", model: "m", prompt: "p", cwd: "/app", agentNumber: 2, runner: "claude" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "agent-resume")).toMatchObject({ resumeSessionId: "sess-77" });
    expect(snap.nodes.find((n) => n.id === "agent-fresh")).not.toHaveProperty("resumeSessionId");
  });

  it("keeps a Claude agent's account through save and reopen (issues/07)", () => {
    const nodes: Node[] = [
      { id: "agent-hss", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "d", name: "A", model: "m", prompt: "p", cwd: "/app", agentNumber: 1, runner: "claude", account: "hss" } },
      { id: "agent-global", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "d", name: "B", model: "m", prompt: "p", cwd: "/app", agentNumber: 2, runner: "claude" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: [], noteContent: new Map() });
    const decoded = decodeCanvasSnapshot(JSON.parse(JSON.stringify(snap)));
    if (!decoded.ok) throw new Error(decoded.error);
    const reopened = (id: string) => {
      const rec = decoded.snapshot.nodes.find((n) => n.id === id) as CanvasAgentNodeRecord;
      return agentRecordToNode(rec, "/app", rec.position).data;
    };
    expect(reopened("agent-hss").account).toBe("hss");
    expect(reopened("agent-global")).not.toHaveProperty("account");
  });

  it("persists a live agent's execution mode and omits it for headless (ADR-0022)", () => {
    const nodes: Node[] = [
      { id: "agent-live", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "d", name: "A", model: "m", prompt: "p", cwd: "/app", agentNumber: 1, executionMode: "live" } },
      { id: "agent-hl", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "d", name: "B", model: "m", prompt: "p", cwd: "/app", agentNumber: 2, executionMode: "headless" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "agent-live")).toMatchObject({ executionMode: "live" });
    // Headless is the load-default, so it is not written — keeps snapshots lean and old boards stable.
    expect(snap.nodes.find((n) => n.id === "agent-hl")).not.toHaveProperty("executionMode");
  });

  it("persists the agent's runner so the kernel can resolve its command after reload (ADR-0023)", () => {
    const nodes: Node[] = [
      { id: "agent-r", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "d", name: "Rex", model: "m", prompt: "p", cwd: "/app", agentNumber: 1, executionMode: "live", runner: "codex" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "agent-r")).toMatchObject({ runner: "codex" });
  });

  it("persists the agent's persona colour across reload (Slice 6)", () => {
    const nodes: Node[] = [
      { id: "agent-c", type: "agent", position: { x: 0, y: 0 }, width: 320, height: 240,
        data: { agentDefId: "d", name: "Skye", model: "m", prompt: "p", cwd: "/app", agentNumber: 1, executionMode: "live", color: "#a78bfa" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "agent-c")).toMatchObject({ color: "#a78bfa" });
  });

  it("serializes a plan node's title and steps", () => {
    const planNodes: Node[] = [
      { id: "plan-1", type: "plan", position: { x: 5, y: 5 }, width: 300, height: 260,
        data: { title: "Sprint", steps: [{ title: "Build", owner: "Backend", done: false }] } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: planNodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "plan-1")).toMatchObject({
      type: "plan", title: "Sprint", steps: [{ title: "Build", owner: "Backend", done: false }],
    });
  });

  it("serializes a team node's runnable members and goal", () => {
    const teamNodes: Node[] = [
      { id: "team-1", type: "team", position: { x: 8, y: 8 }, width: 360, height: 240, data: {
        cwd: "/app",
        teamId: "team_feature_dev_01",
        name: "Coder Team",
        description: "Implementation squad",
        goal: "Ship the approved plan",
        members: [{ id: "coder", name: "Coder", role: "Developer", model: "claude-sonnet-4-6", prompt: "Build", appliedSkills: ["tdd"], updatedAt: 0 }],
      } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: teamNodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "team-1")).toMatchObject({
      type: "team",
      cwd: "/app",
      teamId: "team_feature_dev_01",
      name: "Coder Team",
      goal: "Ship the approved plan",
      members: [expect.objectContaining({ name: "Coder", prompt: "Build" })],
    });
  });

  it("serializes a context node's bus title (artifacts live in the bus, not the snapshot)", () => {
    const contextNodes: Node[] = [
      { id: "ctx-1", type: "context", position: { x: 7, y: 7 }, width: 320, height: 300, data: { title: "Design docs" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: contextNodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "ctx-1")).toMatchObject({ type: "context", title: "Design docs", size: { w: 320, h: 300 } });
  });

  it("serializes a music node's playback state as type music (not the note fallback)", () => {
    const musicNodes: Node[] = [
      { id: "music-1", type: "music", position: { x: 5, y: 5 }, width: 400, height: 560, data: { activeTrackId: "track-a", volume: 65 } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: musicNodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "music-1")).toMatchObject({ type: "music", activeTrackId: "track-a", volume: 65, size: { w: 400, h: 560 } });
  });

  it("serializes a critic node's title and model", () => {
    const criticNodes: Node[] = [
      { id: "crit-1", type: "critic", position: { x: 9, y: 9 }, width: 300, height: 260, data: { title: "Security Gate", model: "claude-sonnet-4-6", cwd: "/app" } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: criticNodes, edges: [], noteContent: new Map() });
    expect(snap.nodes.find((n) => n.id === "crit-1")).toMatchObject({ type: "critic", title: "Security Gate", model: "claude-sonnet-4-6" });
  });

  it("serializes a note node's content and note number", () => {
    const numbered = nodes.map((node) => node.id === "note-1" ? { ...node, data: { ...node.data, noteNumber: 4 } } : node);
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: numbered, edges, noteContent: new Map([["note-1", "checklist"]]), noteCounter: 4 });
    expect(snap.nodes.find((n) => n.id === "note-1")).toMatchObject({ type: "note", content: "checklist", noteNumber: 4 });
    expect(snap.noteCounter).toBe(4);
  });

  it("strips runtime-only cyclic objects from note node snapshots before IPC", () => {
    const cyclicPosition = { x: 12, y: 34 } as { x: number; y: number; self?: unknown };
    cyclicPosition.self = cyclicPosition;
    const cyclicData = { content: "ignored" } as { content: string; self?: unknown };
    cyclicData.self = cyclicData;
    const cyclicNodes: Node[] = [
      { id: "note-cyclic", type: "note", position: cyclicPosition, width: 300, height: 200, data: cyclicData } as unknown as Node,
    ];

    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: cyclicNodes, edges: [], noteContent: new Map([["note-cyclic", "safe"]]) });

    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(snap.nodes[0]).toMatchObject({ type: "note", position: { x: 12, y: 34 }, content: "safe" });
  });

  it("serializes an agent node's definition reference, cached config, and counter", () => {
    const agentNodes: Node[] = [
      { id: "agent-1", type: "agent", position: { x: 20, y: 20 }, width: 320, height: 240,
        data: { agentDefId: "def-7", name: "Frontend Specialist", model: "claude-sonnet-4-6", prompt: "build the UI", cwd: "/app", agentNumber: 1, appliedSkills: ["tdd", "frontend-design"] } },
    ];
    const snap = toCanvasSnapshot({ id: "default", rootDir: "/app", nodes: agentNodes, edges: [], noteContent: new Map(), agentCounter: 1 });
    expect(snap.nodes.find((n) => n.id === "agent-1")).toMatchObject({
      type: "agent", agentDefId: "def-7", name: "Frontend Specialist", model: "claude-sonnet-4-6", prompt: "build the UI", cwd: "/app", agentNumber: 1, size: { w: 320, h: 240 }, appliedSkills: ["tdd", "frontend-design"],
    });
    expect(snap.agentCounter).toBe(1);
  });
});
