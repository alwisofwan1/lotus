import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DndContext } from "@dnd-kit/core";
import type { SkillEntry } from "@/lib/tauri/skills";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => <div data-testid="node-resizer" />,
  };
});

const mockListSkills = vi.fn<(path?: string) => Promise<SkillEntry[]>>();
vi.mock("@/lib/tauri/skills", () => ({ listSkills: (...args: unknown[]) => mockListSkills(...(args as [string?])) }));

import { CanvasSkillsNode } from "../nodes/CanvasSkillsNode";
import type { CanvasSkillsNodeData } from "../../types/canvas";

const PROJECT_SKILL: SkillEntry = { name: "ship", description: "Ship changes", content: "# Ship", source: "project", path: "" };
const GLOBAL_SKILL:  SkillEntry = { name: "changelog", description: "Update changelog", content: "# Log", source: "global", path: "" };

function renderNode(data: Partial<CanvasSkillsNodeData> = {}, skills: SkillEntry[] = [PROJECT_SKILL, GLOBAL_SKILL]) {
  mockListSkills.mockResolvedValue(skills);
  const props = {
    id: "skills-1",
    data: {
      parentTerminalId: "term-1",
      cwd: "/projects/app",
      onOpenSkill: vi.fn(),
      isSkillApplied: () => false,
      onReEnableSkill: vi.fn(),
      onClose: vi.fn(),
      ...data,
    },
    selected: false,
  } as unknown as Parameters<typeof CanvasSkillsNode>[0];
  return render(<DndContext><CanvasSkillsNode {...props} /></DndContext>);
}

function body() {
  return document.querySelector(".canvas-skills-node-body") as HTMLElement;
}

/** The list column. Scoped because the auto-selected skill's name also renders in the reader. */
function list() {
  return screen.getByRole("listbox", { name: /skills/i });
}

describe("CanvasSkillsNode", () => {
  beforeEach(() => {
    mockListSkills.mockReset();
    window.localStorage.clear();
  });

  it("loads skills using the node's cwd", async () => {
    renderNode();
    await waitFor(() => expect(mockListSkills).toHaveBeenCalledWith("/projects/app"));
  });

  it("renders each skill name prefixed with /", async () => {
    renderNode();
    await waitFor(() => {
      expect(within(list()).getByText("/ship")).toBeInTheDocument();
      expect(within(list()).getByText("/changelog")).toBeInTheDocument();
    });
  });

  it("shows descriptions only while searching — the reader carries them when browsing", async () => {
    renderNode();
    await waitFor(() => within(list()).getByText("/ship"));

    expect(within(list()).queryByText("Ship changes")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: /search skills/i }), { target: { value: "ship" } });

    expect(within(list()).getByText("Ship changes")).toBeInTheDocument();
  });

  it("groups by source while browsing", async () => {
    renderNode();
    await waitFor(() => within(list()).getByText("/ship"));
    expect(screen.getByRole("heading", { name: /project/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /global/i })).toBeInTheDocument();
  });

  it("filters the list as the user searches, and collapses to one ranked group", async () => {
    renderNode();
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.change(screen.getByRole("searchbox", { name: /search skills/i }), { target: { value: "log" } });

    expect(within(list()).queryByText("/ship")).not.toBeInTheDocument();
    expect(within(list()).getByText("/changelog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /results/i })).toBeInTheDocument();
  });

  it("reports a search with no matches instead of showing an empty list", async () => {
    renderNode();
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.change(screen.getByRole("searchbox", { name: /search skills/i }), { target: { value: "zzzz" } });

    expect(screen.getByText(/no skill matches/i)).toBeInTheDocument();
  });

  it("narrows to one source via the filter chips", async () => {
    renderNode();
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.click(screen.getByRole("button", { name: /global/i }));

    expect(within(list()).queryByText("/ship")).not.toBeInTheDocument();
    expect(within(list()).getByText("/changelog")).toBeInTheDocument();
  });

  it("previews the selected skill in place — no second node", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand, onOpenSkill: undefined });
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.click(screen.getByRole("option", { name: /ship/i }));

    const detail = document.querySelector(".canvas-skills-detail") as HTMLElement;
    expect(within(detail).getByText("/ship")).toBeInTheDocument();
    expect(dispatchCommand).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "open-skill" }));
  });

  it("selects the first skill by default so the reader is never blank", async () => {
    renderNode();
    await waitFor(() => within(list()).getByText("/ship"));

    expect(screen.getByRole("option", { name: /ship/i })).toHaveAttribute("aria-selected", "true");
  });

  it("pops the selected skill out as its own node on demand", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand, onOpenSkill: undefined });
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.click(screen.getByRole("button", { name: /pop out \/ship/i }));

    expect(dispatchCommand).toHaveBeenCalledWith({
      kind: "open-skill",
      skillsNodeId: "skills-1",
      skill: expect.objectContaining({ name: "ship", content: "# Ship" }),
    });
  });

  it("applies a skill from its row button without a drag", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand });
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.click(screen.getByRole("button", { name: "Apply /ship" }));

    expect(dispatchCommand).toHaveBeenCalledWith({
      kind: "apply-skill",
      targetId: "term-1",
      skill: expect.objectContaining({ name: "ship" }),
    });
  });

  it("applies the active skill on Enter and pops it out on ⌘Enter", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand, onOpenSkill: undefined });
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.keyDown(body(), { key: "Enter" });
    expect(dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "apply-skill" }));

    fireEvent.keyDown(body(), { key: "Enter", metaKey: true });
    expect(dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "open-skill" }));
  });

  it("moves the selection with the arrow keys", async () => {
    renderNode();
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.keyDown(body(), { key: "ArrowDown" });

    expect(screen.getByRole("option", { name: /changelog/i })).toHaveAttribute("aria-selected", "true");
  });

  it("Escape clears the search first, then closes the node", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand, onClose: undefined });
    await waitFor(() => within(list()).getByText("/ship"));

    const search = screen.getByRole("searchbox", { name: /search skills/i });
    fireEvent.change(search, { target: { value: "chang" } });
    fireEvent.keyDown(body(), { key: "Escape" });

    expect(search).toHaveValue("");
    expect(dispatchCommand).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "close-node" }));

    fireEvent.keyDown(body(), { key: "Escape" });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "skills-1" });
  });

  it("floats a used skill into a Recent group on reload", async () => {
    const { unmount } = renderNode({ dispatchCommand: vi.fn() });
    await waitFor(() => within(list()).getByText("/changelog"));
    fireEvent.click(screen.getByRole("button", { name: "Apply /changelog" }));
    unmount();

    renderNode({ dispatchCommand: vi.fn() });
    await waitFor(() => screen.getByRole("heading", { name: /recent/i }));
    const recent = screen.getByRole("heading", { name: /recent/i }).parentElement!;
    expect(within(recent).getByText("/changelog")).toBeInTheDocument();
  });

  it("prints Claude's slash token by default", async () => {
    renderNode();
    await waitFor(() => expect(within(list()).getByText("/ship")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Apply /ship" })).toBeInTheDocument();
  });

  it("prints Codex's $ token when the parent runs codex", async () => {
    renderNode({ parentRunner: "codex" });
    await waitFor(() => expect(within(list()).getByText("$ship")).toBeInTheDocument());

    // The reader header and the row agree — both derive from one invocation style.
    const detail = document.querySelector(".canvas-skills-detail") as HTMLElement;
    expect(within(detail).getByText("$ship")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply $ship" })).toBeInTheDocument();
  });

  it("prints a bare name for a runner with no skill command", async () => {
    renderNode({ parentRunner: "cursor" });
    await waitFor(() => expect(within(list()).getByText("ship")).toBeInTheDocument());
    expect(within(list()).queryByText("/ship")).not.toBeInTheDocument();
  });

  it("honours the claudeFamily override on a custom parent runner", async () => {
    renderNode({ parentRunner: "custom", parentClaudeFamily: true });
    await waitFor(() => expect(within(list()).getByText("/ship")).toBeInTheDocument());
  });

  it("marks an applied skill row, and the marker clears itself on click", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand, isSkillApplied: (_t, name) => name === "ship", onReEnableSkill: undefined });
    await waitFor(() => within(list()).getByText("/ship"));

    const marker = within(list()).getByRole("button", { name: /clear the applied marker on \/ship/i });
    expect(marker).toHaveTextContent(/applied/i);
    fireEvent.click(marker);

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "reenable-skill", terminalId: "term-1", skillName: "ship" });
  });

  it("still applies an already-applied skill — the operator may have deleted the token", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand, isSkillApplied: () => true });
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.click(within(list()).getByRole("button", { name: "Apply /ship again" }));

    expect(dispatchCommand).toHaveBeenCalledWith({
      kind: "apply-skill",
      targetId: "term-1",
      skill: expect.objectContaining({ name: "ship" }),
    });
  });

  it("re-applies an applied skill from the keyboard too", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand, isSkillApplied: () => true });
    await waitFor(() => within(list()).getByText("/ship"));

    fireEvent.keyDown(body(), { key: "Enter" });

    expect(dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "apply-skill" }));
  });

  it("keeps the reader's Apply available on an applied skill, labelled as a repeat", async () => {
    renderNode({ dispatchCommand: vi.fn(), isSkillApplied: () => true });
    await waitFor(() => within(list()).getByText("/ship"));

    const detail = document.querySelector(".canvas-skills-detail") as HTMLElement;
    expect(within(detail).getByRole("button", { name: /apply again/i })).toBeInTheDocument();
  });

  it("closes via the node command seam", async () => {
    const dispatchCommand = vi.fn();
    renderNode({ dispatchCommand, onClose: undefined }, []);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "skills-1" });
  });

  it("shows empty state when there are no skills", async () => {
    renderNode({}, []);
    await waitFor(() => expect(screen.getByText(/no skills/i)).toBeInTheDocument());
  });
});
