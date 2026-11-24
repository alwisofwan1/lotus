import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => <div data-testid="node-resizer" />,
  };
});

// The markdown renderer is its own tested concern — stub it and assert content passes through.
vi.mock("@/modules/codespace/components/workbench/WorkbenchMarkdownPreview", () => ({
  WorkbenchMarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}));

import { CanvasSkillNode } from "../nodes/CanvasSkillNode";
import type { CanvasSkillNodeData } from "../../types/canvas";

function makeProps(overrides?: Partial<CanvasSkillNodeData>) {
  return {
    id: "skill-1",
    data: {
      skillName: "ship",
      source: "project",
      content: "# Ship\nShips changes.",
      onClose: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof CanvasSkillNode>[0];
}

describe("CanvasSkillNode", () => {
  it("renders the skill name as /name in the header", () => {
    render(<CanvasSkillNode {...makeProps({ skillName: "ship" })} />);
    expect(screen.getByText("/ship")).toBeInTheDocument();
  });

  it("emits close through the node command seam", () => {
    const dispatchCommand = vi.fn();
    render(<CanvasSkillNode {...makeProps({ dispatchCommand, onClose: undefined })} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "skill-1" });
  });

  it("shows a PROJECT badge for project skills", () => {
    render(<CanvasSkillNode {...makeProps({ source: "project" })} />);
    expect(screen.getByText("PROJECT")).toBeInTheDocument();
  });

  it("shows a GLOBAL badge for global skills", () => {
    render(<CanvasSkillNode {...makeProps({ source: "global" })} />);
    expect(screen.getByText("GLOBAL")).toBeInTheDocument();
  });

  it("renders the SKILL.md content through the markdown preview", () => {
    render(<CanvasSkillNode {...makeProps({ content: "# Ship\nShips changes." })} />);
    expect(screen.getByTestId("markdown-preview")).toHaveTextContent("Ships changes.");
  });
});
