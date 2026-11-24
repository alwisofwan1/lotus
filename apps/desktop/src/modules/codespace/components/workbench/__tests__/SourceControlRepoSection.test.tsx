import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { SourceControlRepoSection } from "../SourceControlRepoSection";
import type { CodespaceGitFileStatus } from "@/lib/tauri-api";

describe("SourceControlRepoSection", () => {
  const statuses: CodespaceGitFileStatus[] = [
    { path: "/repo/src/a.ts", relativePath: "src/a.ts", staged: "modified", unstaged: null },
    { path: "/repo/src/b.ts", relativePath: "src/b.ts", staged: null, unstaged: "untracked" },
  ];

  function renderSection(overrides: Partial<ComponentProps<typeof SourceControlRepoSection>> = {}) {
    const props: ComponentProps<typeof SourceControlRepoSection> = {
      rootDir: "/repo",
      statuses,
      summary: { branch: "main", head: "abc", upstream: "origin/main", ahead: 2, behind: 0 },
      available: true,
      loading: false,
      actionPath: null,
      commitMessage: "",
      committing: false,
      pushing: false,
      aiSuggesting: false,
      error: null,
      defaultExpanded: true,
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
    return { ...props, ...render(<SourceControlRepoSection {...props} />) };
  }

  it("renders repo name from rootDir basename", () => {
    renderSection();
    expect(screen.getByText("repo")).toBeInTheDocument();
  });

  it("shows branch and ahead count, with arrows rather than signs", () => {
    renderSection({ summary: { branch: "main", head: "abc", upstream: "origin/main", ahead: 2, behind: 240 } });
    expect(screen.getByLabelText("Branch main")).toHaveTextContent("main");
    expect(screen.getByText("↑2 ↓240")).toHaveAttribute("title", "2 to push, 240 to pull (origin/main)");
  });

  it("puts the branch under the name, whole, and shows it in a popover only when it is cut", () => {
    const branch = "feat/TKT-649-billing-form-validation-and-invoice-polish";
    renderSection({
      rootDir: "/projects/recolgo-desktop",
      summary: { branch, head: "abc", upstream: `origin/${branch}`, ahead: 0, behind: 0 },
    });

    expect(screen.getByText("recolgo-desktop")).toBeInTheDocument();
    const chip = screen.getByLabelText(`Branch ${branch}`);
    expect(chip).toHaveTextContent(branch);

    // Fits: no popover.
    fireEvent.mouseEnter(chip);
    expect(document.body.querySelector(".source-repo-branch-popover")).toBeNull();
    fireEvent.mouseLeave(chip);

    // Cut by the sidebar's width.
    Object.defineProperty(chip, "scrollWidth", { configurable: true, value: 300 });
    Object.defineProperty(chip, "clientWidth", { configurable: true, value: 120 });

    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue({
      x: 164,
      y: 72,
      top: 72,
      right: 222,
      bottom: 88,
      left: 164,
      width: 58,
      height: 16,
      toJSON: () => ({}),
    });
    fireEvent.mouseEnter(chip);

    const popover = document.body.querySelector<HTMLElement>(".source-repo-branch-popover");
    expect(popover).toHaveTextContent(branch);
    expect(popover?.style.left).not.toBe("");
    expect(popover?.style.width).not.toBe("");
  });

  it("renders staged and unstaged groups", () => {
    renderSection();
    expect(screen.getByText("Staged")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
  });

  it("offers the commit box only when there is something to commit, and Push only when there is something to push", () => {
    renderSection({ statuses: [], summary: { branch: "main", head: "abc", upstream: "origin/main", ahead: 0, behind: 0 } });
    expect(screen.queryByPlaceholderText(/commit message/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /push/i })).toBeNull();
    expect(screen.getByText("Working tree clean")).toBeInTheDocument();
  });

  it("says why Commit waits when nothing is staged", () => {
    renderSection({ statuses: [statuses[1]], commitMessage: "fix: x" });
    const commit = screen.getByRole("button", { name: /^commit$/i });
    expect(commit).toBeDisabled();
    expect(commit).toHaveAttribute("title", "Stage changes to commit them");
  });

  it("collapses content when header is clicked", () => {
    renderSection();
    // Click the repo header to collapse
    fireEvent.click(screen.getByRole("button", { name: /toggle repo/i }));
    // Staged/unstaged should be hidden
    expect(screen.queryByText("Staged")).not.toBeInTheDocument();
  });

  it("routes stage/unstage actions", () => {
    const props = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Stage b.ts" }));
    expect(props.onStageFile).toHaveBeenCalledWith("/repo/src/b.ts");
  });

  it("shows commit input and enables commit when message + staged files exist", () => {
    const props = renderSection({ commitMessage: "feat: add b" });
    const commitBtn = screen.getByRole("button", { name: /^commit$/i });
    expect(commitBtn).not.toBeDisabled();
    fireEvent.click(commitBtn);
    expect(props.onCommit).toHaveBeenCalled();
  });

  it("shows unavailable state when repo has no git", () => {
    renderSection({ available: false, statuses: [] });
    expect(screen.getByText(/no repository/i)).toBeInTheDocument();
  });
});
