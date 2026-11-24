import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, Handle: () => null };
});

import { CanvasTerminalHeader } from "../nodes/CanvasTerminalHeader";
import type { CanvasTerminalHeaderProps } from "../nodes/CanvasTerminalHeader";

function makeProps(overrides?: Partial<CanvasTerminalHeaderProps>): CanvasTerminalHeaderProps {
  return {
    terminalNumber: 1,
    runtimeStatus: "idle",
    activity: "idle",
    currentCwd: "/projects/app",
    assignedWorktree: null,
    worktreeActive: false,
    skillsActive: false,
    onKill: vi.fn(),
    onToggleWT: vi.fn(),
    onToggleSK: vi.fn(),
    ...overrides,
  };
}

describe("CanvasTerminalHeader", () => {
  describe("identity", () => {
    it("shows the terminal number", () => {
      render(<CanvasTerminalHeader {...makeProps({ terminalNumber: 3 })} />);
      expect(screen.getByText(/terminal 3/i)).toBeInTheDocument();
    });

    it("marks the dot as starting when starting", () => {
      render(<CanvasTerminalHeader {...makeProps({ runtimeStatus: "starting" })} />);
      expect(document.querySelector(".cth-dot--starting")).toBeInTheDocument();
    });

    it("opens rename with a right-click and commits with Enter", () => {
      const onRename = vi.fn();
      render(<CanvasTerminalHeader {...makeProps({ label: "API server", onRename })} />);

      const name = screen.getByText("API server");
      fireEvent.contextMenu(name);
      const input = screen.getByRole("textbox", { name: "Terminal name" });
      fireEvent.change(input, { target: { value: "Test runner" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRename).toHaveBeenCalledWith("Test runner");
    });

    it("does not enter rename mode on double-click", () => {
      render(<CanvasTerminalHeader {...makeProps({ label: "API server", onRename: vi.fn() })} />);

      fireEvent.doubleClick(screen.getByText("API server"));

      expect(screen.queryByRole("textbox", { name: "Terminal name" })).not.toBeInTheDocument();
    });
  });

  // Revamp (ADR-0033): no status word — liveness rides the dot only.
  describe("status dot", () => {
    it("marks the dot running when live and working", () => {
      render(<CanvasTerminalHeader {...makeProps({ runtimeStatus: "live", activity: "running" })} />);
      expect(document.querySelector(".cth-dot--running")).toBeInTheDocument();
    });

    it("marks the dot idle when live but not working", () => {
      render(<CanvasTerminalHeader {...makeProps({ runtimeStatus: "live", activity: "idle" })} />);
      expect(screen.queryByText(/live/i)).not.toBeInTheDocument();
      expect(document.querySelector(".cth-dot--idle")).toBeInTheDocument();
    });

    it("ignores activity when not live; the dot reflects the runtime status", () => {
      render(<CanvasTerminalHeader {...makeProps({ runtimeStatus: "exited", activity: "running" })} />);
      expect(document.querySelector(".cth-dot--running")).not.toBeInTheDocument();
      expect(document.querySelector(".cth-dot--exited")).toBeInTheDocument();
    });
  });

  // Revamp (ADR-0033): cwd/worktree is inline in the single header row (no second path row).
  describe("location (cwd / worktree)", () => {
    it("shows the cwd folder name when no worktree is assigned", () => {
      render(<CanvasTerminalHeader {...makeProps({ currentCwd: "/projects/my-app" })} />);
      expect(screen.getByText("my-app")).toBeInTheDocument();
    });

    it("shows the assigned worktree branch instead of cwd when worktree is set", () => {
      render(<CanvasTerminalHeader {...makeProps({
        currentCwd: "/projects/my-app",
        assignedWorktree: "feature/login-red-bg",
      })} />);
      expect(screen.getByText("feature/login-red-bg")).toBeInTheDocument();
      expect(screen.queryByText("my-app")).not.toBeInTheDocument();
    });

    it("applies the worktree class to the location when a worktree is assigned", () => {
      render(<CanvasTerminalHeader {...makeProps({ assignedWorktree: "feature/foo" })} />);
      expect(document.querySelector(".cth-loc--worktree")).toBeInTheDocument();
    });
  });

  describe("action bar", () => {
    it("renders WT, SK, and Kill buttons", () => {
      render(<CanvasTerminalHeader {...makeProps()} />);
      expect(screen.getByRole("button", { name: "Worktree" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Skill" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Kill terminal" })).toBeInTheDocument();
    });

    it("calls onToggleWT when WT is clicked", () => {
      const onToggleWT = vi.fn();
      render(<CanvasTerminalHeader {...makeProps({ onToggleWT })} />);
      fireEvent.click(screen.getByRole("button", { name: "Worktree" }));
      expect(onToggleWT).toHaveBeenCalledOnce();
    });

    it("calls onToggleSK when SK is clicked", () => {
      const onToggleSK = vi.fn();
      render(<CanvasTerminalHeader {...makeProps({ onToggleSK })} />);
      fireEvent.click(screen.getByRole("button", { name: "Skill" }));
      expect(onToggleSK).toHaveBeenCalledOnce();
    });

    it("calls onKill when Kill is clicked", () => {
      const onKill = vi.fn();
      render(<CanvasTerminalHeader {...makeProps({ onKill })} />);
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
      expect(onKill).toHaveBeenCalledOnce();
    });

    it("marks the WT button active when worktreeActive is true", () => {
      render(<CanvasTerminalHeader {...makeProps({ worktreeActive: true })} />);
      expect(screen.getByRole("button", { name: "Worktree" })).toHaveClass("cth-action--active");
    });

    it("marks the SK button active when a Skills node exists", () => {
      render(<CanvasTerminalHeader {...makeProps({ skillsActive: true })} />);
      expect(screen.getByRole("button", { name: "Skill" })).toHaveClass("cth-action--active");
    });
  });
});
