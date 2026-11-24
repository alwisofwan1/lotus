import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { SourceControlPanel } from "../SourceControlPanel";
import type { CodespaceGitFileStatus } from "@/lib/tauri-api";

type SingleRepoPanelProps = Extract<ComponentProps<typeof SourceControlPanel>, { rootDir: string }>;

describe("SourceControlPanel", () => {
  const statuses: CodespaceGitFileStatus[] = [
    {
      path: "/workspace/project/src/app.ts",
      relativePath: "src/app.ts",
      staged: "modified",
      unstaged: null,
    },
    {
      path: "/workspace/project/src/new.ts",
      relativePath: "src/new.ts",
      staged: null,
      unstaged: "untracked",
    },
  ];

  function renderPanel(overrides: Partial<SingleRepoPanelProps> = {}) {
    const props: SingleRepoPanelProps = {
      rootDir: "/workspace/project",
      statuses,
      summary: {
        branch: "main",
        head: "abc123",
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
      },
      gitAvailable: true,
      loading: false,
      actionPath: null,
      commitMessage: "",
      committing: false,
      pushing: false,
      aiSuggesting: false,
      error: null,
      onCommitMessageChange: vi.fn(),
      onCommit: vi.fn(),
      onPush: vi.fn(),
      onAiSuggestCommit: vi.fn(),
      onRefresh: vi.fn(),
      onStageFile: vi.fn(),
      onUnstageFile: vi.fn(),
      onStageAll: vi.fn(),
      onUnstageAll: vi.fn(),
      onDiscardAllChanges: vi.fn(),
      onViewDiff: vi.fn(),
      ...overrides,
    };

    const view = render(<SourceControlPanel {...props} />);
    return { ...props, container: view.container };
  }

  it("groups staged and unstaged files", () => {
    renderPanel();

    expect(screen.getByText("Staged")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("new.ts")).toBeInTheDocument();
    expect(screen.getByText("↑1")).toBeInTheDocument();
  });

  it("renders compact workbench file icons without duplicate folder labels", () => {
    const { container } = renderPanel();

    expect(container.querySelectorAll(".codespace-workbench-file-icon")).toHaveLength(2);
    expect(container.querySelectorAll(".codespace-workbench-source-folder-icon")).toHaveLength(0);
    expect(screen.queryByText("src")).not.toBeInTheDocument();
  });

  it("routes file actions to the workbench", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Stage new.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Unstage app.ts" }));
    fireEvent.click(screen.getByTitle("src/new.ts"));

    expect(props.onStageFile).toHaveBeenCalledWith("/workspace/project/src/new.ts");
    expect(props.onUnstageFile).toHaveBeenCalledWith("/workspace/project/src/app.ts");
    expect(props.onViewDiff).toHaveBeenCalledWith("/workspace/project/src/new.ts", "unstaged");
  });

  it("enables commit only when a staged file and message exist", () => {
    const props = renderPanel({ commitMessage: "fix: update app" });

    fireEvent.click(screen.getByRole("button", { name: /^commit$/i }));

    expect(props.onCommit).toHaveBeenCalled();
  });

  it("places bulk actions on their source control sections", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const props = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Stage all changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard all changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Unstage all changes" }));

    expect(props.onStageAll).toHaveBeenCalled();
    expect(props.onDiscardAllChanges).toHaveBeenCalled();
    expect(props.onUnstageAll).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does not show unavailable section actions", () => {
    renderPanel({
      statuses: [{
        path: "/workspace/project/src/new.ts",
        relativePath: "src/new.ts",
        staged: null,
        unstaged: "untracked",
      }],
    });

    expect(screen.getByRole("button", { name: "Stage all changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard all changes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unstage all changes" })).not.toBeInTheDocument();
  });

  it("does not report missing repository when summary is unavailable but status succeeded", () => {
    renderPanel({ statuses: [], summary: null, gitAvailable: true });

    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.getByText("Working tree clean")).toBeInTheDocument();
    expect(screen.queryByText("No Git repository")).not.toBeInTheDocument();
  });
});
