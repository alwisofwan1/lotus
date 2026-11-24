import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeEntry } from "@/lib/tauri/canvas-git";

const mockListGitWorktrees = vi.fn<(path: string) => Promise<WorktreeEntry[]>>();
const mockCreateGitWorktree = vi.fn<() => Promise<WorktreeEntry>>();
const mockRemoveGitWorktree = vi.fn<() => Promise<void>>();
vi.mock("@/lib/tauri/canvas-git", () => ({
  listGitWorktrees: (...args: unknown[]) => mockListGitWorktrees(...(args as [string])),
  createGitWorktree: (...args: unknown[]) => mockCreateGitWorktree(...(args as [])),
  removeGitWorktree: (...args: unknown[]) => mockRemoveGitWorktree(...(args as [])),
}));

import { CanvasWorktreePanel } from "../panels/CanvasWorktreePanel";

const MAIN: WorktreeEntry     = { path: "/projects/app", branch: "main", isMain: true };
const FEATURE: WorktreeEntry  = { path: "/projects/app-worktrees/feature-foo", branch: "feature/foo", isMain: false };

const DETACHED: WorktreeEntry = { path: "/projects/app-wt/detached", branch: null, isMain: false };

function setup(entries: WorktreeEntry[] = [MAIN, FEATURE], writeToTerminal?: (cmd: string) => void) {
  mockListGitWorktrees.mockResolvedValue(entries);
  return render(
    <CanvasWorktreePanel
      cwd="/projects/app"
      assignedWorktree={null}
      onAssign={vi.fn()}
      onUnassign={vi.fn()}
      onClose={vi.fn()}
      writeToTerminal={writeToTerminal}
    />,
  );
}

describe("CanvasWorktreePanel", () => {
  beforeEach(() => { mockListGitWorktrees.mockReset(); mockCreateGitWorktree.mockReset(); mockRemoveGitWorktree.mockReset(); });

  it("shows loading state before data arrives", () => {
    mockListGitWorktrees.mockReturnValue(new Promise(() => {}));
    render(<CanvasWorktreePanel cwd="/app" assignedWorktree={null} onAssign={vi.fn()} onUnassign={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText(/loading worktrees/i)).toBeInTheDocument();
  });

  it("fetches worktrees using the given cwd", async () => {
    setup();
    await waitFor(() => expect(mockListGitWorktrees).toHaveBeenCalledWith("/projects/app"));
  });

  it("renders each worktree branch name", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getAllByText("main").length).toBeGreaterThan(0);
      expect(screen.getAllByText("feature/foo").length).toBeGreaterThan(0);
    });
  });

  it("highlights the currently assigned worktree", async () => {
    mockListGitWorktrees.mockResolvedValue([MAIN, FEATURE]);
    render(
      <CanvasWorktreePanel
        cwd="/projects/app"
        assignedWorktree="feature/foo"
        onAssign={vi.fn()}
        onUnassign={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      // cwp-row--active is on the row div wrapping the button
      const activeRow = screen.getAllByText("feature/foo")
        .map((el) => el.closest(".cwp-row"))
        .find((row) => row?.classList.contains("cwp-row--active"));
      expect(activeRow).toBeDefined();
    });
  });

  it("calls onAssign with the branch and worktree path when a row is clicked", async () => {
    const onAssign = vi.fn();
    mockListGitWorktrees.mockResolvedValue([MAIN, FEATURE]);
    render(<CanvasWorktreePanel cwd="/projects/app" assignedWorktree={null} onAssign={onAssign} onUnassign={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("feature/foo"));
    fireEvent.click(screen.getByText("feature/foo").closest("button")!);
    expect(onAssign).toHaveBeenCalledWith("feature/foo", "/projects/app-worktrees/feature-foo");
  });

  it("shows the Unassign button when a worktree is currently assigned", async () => {
    mockListGitWorktrees.mockResolvedValue([FEATURE]);
    render(<CanvasWorktreePanel cwd="/projects/app" assignedWorktree="feature/foo" onAssign={vi.fn()} onUnassign={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /unassign/i })).toBeInTheDocument());
  });

  it("calls onUnassign when the Unassign button is clicked", async () => {
    const onUnassign = vi.fn();
    mockListGitWorktrees.mockResolvedValue([FEATURE]);
    render(<CanvasWorktreePanel cwd="/projects/app" assignedWorktree="feature/foo" onAssign={vi.fn()} onUnassign={onUnassign} onClose={vi.fn()} />);
    await waitFor(() => fireEvent.click(screen.getByRole("button", { name: /unassign/i })));
    expect(onUnassign).toHaveBeenCalledOnce();
  });

  it("shows empty state when the repo has no worktrees", async () => {
    setup([]);
    await waitFor(() => expect(screen.getByText(/no worktrees/i)).toBeInTheDocument());
  });

  it("shows not-a-git-repo state and hides create form when listGitWorktrees rejects", async () => {
    mockListGitWorktrees.mockRejectedValue(new Error("fatal: not a git repository"));
    render(<CanvasWorktreePanel cwd="/tmp/not-a-repo" assignedWorktree={null} onAssign={vi.fn()} onUnassign={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/not a git repository/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /new worktree/i })).not.toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    mockListGitWorktrees.mockReturnValue(new Promise(() => {}));
    render(<CanvasWorktreePanel cwd="/app" assignedWorktree={null} onAssign={vi.fn()} onUnassign={onClose} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("refresh button re-fetches the worktree list", async () => {
    setup();
    await waitFor(() => screen.getByText("feature/foo"));
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(mockListGitWorktrees).toHaveBeenCalledTimes(2));
  });

  it("main worktree shows a main badge marker", async () => {
    setup([MAIN]);
    await waitFor(() => {
      // The main badge uses ★ symbol with aria-label="main worktree"
      expect(screen.getByLabelText("main worktree")).toBeInTheDocument();
    });
  });

  it("detached HEAD row is disabled — clicking does nothing", async () => {
    const onAssign = vi.fn();
    mockListGitWorktrees.mockResolvedValue([DETACHED]);
    render(<CanvasWorktreePanel cwd="/app" assignedWorktree={null} onAssign={onAssign} onUnassign={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => screen.getAllByText(/detached/i).length > 0);
    const btn = screen.getAllByText(/detached/i)
      .map((el) => el.closest("button"))
      .find((b) => b !== null);
    expect(btn).toBeDisabled();
    fireEvent.click(btn!);
    expect(onAssign).not.toHaveBeenCalled();
  });

  describe("create form", () => {
    it("is hidden by default — expanded with the New worktree button", async () => {
      setup();
      await waitFor(() => screen.getByText("feature/foo"));
      expect(screen.queryByLabelText(/branch name/i)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /new worktree/i }));
      expect(screen.getByLabelText(/branch name/i)).toBeInTheDocument();
    });

    it("path is auto-derived from cwd and branch — no path input field", async () => {
      setup();
      await waitFor(() => screen.getByText("feature/foo"));
      fireEvent.click(screen.getByRole("button", { name: /new worktree/i }));
      expect(screen.queryByLabelText(/^path$/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/branch name/i)).toBeInTheDocument();
    });

    it("Via Terminal button sends a git worktree add command to the pane", async () => {
      const writeToTerminal = vi.fn();
      setup([MAIN, FEATURE], writeToTerminal);
      await waitFor(() => screen.getByText("feature/foo"));
      fireEvent.click(screen.getByRole("button", { name: /new worktree/i }));
      fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: "feat/new" } });
      fireEvent.click(screen.getByRole("button", { name: /via terminal/i }));
      expect(writeToTerminal).toHaveBeenCalledWith(
        expect.stringContaining("git worktree add"),
      );
    });

    it("Via Terminal button is absent when writeToTerminal is not provided", async () => {
      setup([MAIN]);
      await waitFor(() => screen.getAllByText("main").length > 0);
      fireEvent.click(screen.getByRole("button", { name: /new worktree/i }));
      expect(screen.queryByRole("button", { name: /via terminal/i })).not.toBeInTheDocument();
    });

    it("Create button calls createGitWorktree with auto-derived path and refreshes the list", async () => {
      const newEntry: WorktreeEntry = { path: "/projects/app-feat-new", branch: "feat/new", isMain: false };
      mockCreateGitWorktree.mockResolvedValue(newEntry);
      setup();
      await waitFor(() => screen.getByText("feature/foo"));
      fireEvent.click(screen.getByRole("button", { name: /new worktree/i }));
      fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: "feat/new" } });
      mockListGitWorktrees.mockResolvedValue([MAIN, FEATURE, newEntry]);
      fireEvent.click(screen.getByRole("button", { name: /create worktree/i }));
      await waitFor(() => expect(mockCreateGitWorktree).toHaveBeenCalledWith(
        "/projects/app", "feat/new", expect.stringContaining("app-feat-new"),
      ));
      await waitFor(() => expect(mockListGitWorktrees).toHaveBeenCalledTimes(2));
    });
  });

  describe("spawn terminal", () => {
    it("shows a spawn terminal button for each non-active worktree row when onSpawnTerminal is provided", async () => {
      const onSpawnTerminal = vi.fn();
      mockListGitWorktrees.mockResolvedValue([MAIN, FEATURE]);
      render(
        <CanvasWorktreePanel
          cwd="/projects/app"
          assignedWorktree={null}
          onAssign={vi.fn()}
          onUnassign={vi.fn()}
          onClose={vi.fn()}
          onSpawnTerminal={onSpawnTerminal}
        />,
      );
      await waitFor(() => screen.getByText("feature/foo"));
      expect(screen.getAllByRole("button", { name: /spawn terminal/i }).length).toBeGreaterThan(0);
    });

    it("calls onSpawnTerminal with branch and path when spawn button is clicked", async () => {
      const onSpawnTerminal = vi.fn();
      mockListGitWorktrees.mockResolvedValue([MAIN, FEATURE]);
      render(
        <CanvasWorktreePanel
          cwd="/projects/app"
          assignedWorktree={null}
          onAssign={vi.fn()}
          onUnassign={vi.fn()}
          onClose={vi.fn()}
          onSpawnTerminal={onSpawnTerminal}
        />,
      );
      await waitFor(() => screen.getByText("feature/foo"));
      const spawnBtn = screen.getByRole("button", { name: /spawn terminal for worktree feature\/foo/i });
      fireEvent.click(spawnBtn);
      expect(onSpawnTerminal).toHaveBeenCalledWith("feature/foo", "/projects/app-worktrees/feature-foo");
    });

    it("does not show spawn button for the currently assigned worktree row", async () => {
      const onSpawnTerminal = vi.fn();
      mockListGitWorktrees.mockResolvedValue([MAIN, FEATURE]);
      render(
        <CanvasWorktreePanel
          cwd="/projects/app"
          assignedWorktree="feature/foo"
          onAssign={vi.fn()}
          onUnassign={vi.fn()}
          onClose={vi.fn()}
          onSpawnTerminal={onSpawnTerminal}
        />,
      );
      await waitFor(() => screen.getByText("feature/foo"));
      expect(screen.queryByRole("button", { name: /spawn terminal for worktree feature\/foo/i })).not.toBeInTheDocument();
    });

    it("does not show spawn buttons when onSpawnTerminal is not provided", async () => {
      setup([MAIN, FEATURE]);
      await waitFor(() => screen.getByText("feature/foo"));
      expect(screen.queryByRole("button", { name: /spawn terminal/i })).not.toBeInTheDocument();
    });
  });
});
