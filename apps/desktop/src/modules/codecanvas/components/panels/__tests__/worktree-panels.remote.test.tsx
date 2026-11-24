import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const listWorktreesFor = vi.fn();
const removeWorktreeFor = vi.fn();
const createWorktreeFor = vi.fn();
const uncommittedDiffFor = vi.fn();
const getActiveProjectLocation = vi.fn();

vi.mock("../../../services/remote-git", () => ({
  listWorktreesFor: (...a: unknown[]) => listWorktreesFor(...a),
  removeWorktreeFor: (...a: unknown[]) => removeWorktreeFor(...a),
  createWorktreeFor: (...a: unknown[]) => createWorktreeFor(...a),
  uncommittedDiffFor: (...a: unknown[]) => uncommittedDiffFor(...a),
}));
vi.mock("../../../services/canvas-active-project", () => ({
  getActiveProjectLocation: () => getActiveProjectLocation(),
}));

const { CanvasWorktreePanel } = await import("../CanvasWorktreePanel");
const { WorktreeCreateForm } = await import("../WorktreeCreateForm");
const { AgentDiffPanel } = await import("../AgentDiffPanel");

const SSH = { kind: "ssh" as const, host: "devbox-vps", user: "root" };

describe("the worktree panels, on a project that lives elsewhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveProjectLocation.mockReturnValue(SSH);
    listWorktreesFor.mockResolvedValue([
      { path: "/srv/api", branch: "main", isMain: true },
      { path: "/srv/api-rowan", branch: "lotus/tim/rowan", isMain: false },
    ]);
    removeWorktreeFor.mockResolvedValue(undefined);
    createWorktreeFor.mockResolvedValue({ path: "/srv/api-new", branch: "feat", isMain: false });
  });

  it("lists the worktrees that are on that machine", async () => {
    render(
      <CanvasWorktreePanel
        cwd="/srv/api"
        assignedWorktree={null}
        onAssign={() => {}}
        onUnassign={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listWorktreesFor).toHaveBeenCalledWith(SSH, "/srv/api"));
    expect(await screen.findByText("lotus/tim/rowan")).toBeInTheDocument();
  });

  it("creates on that machine too", async () => {
    render(
      <WorktreeCreateForm cwd="/srv/api" existingCount={1} onCreated={() => {}} onRefresh={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));

    await waitFor(() =>
      expect(createWorktreeFor).toHaveBeenCalledWith(SSH, "/srv/api", "feat", expect.any(String)),
    );
  });

  /**
   * The "Via Terminal" escape hatch writes shell into the agent's own terminal, which is already on
   * the right machine. What it must not do is hide the first attempt's error the way it used to:
   * a branch another worktree holds came back as "a branch named 'x' already exists".
   */
  it("writes a command that reports the real reason it failed", () => {
    const writeToTerminal = vi.fn();
    render(
      <WorktreeCreateForm
        cwd="/srv/api"
        existingCount={1}
        writeToTerminal={writeToTerminal}
        onCreated={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feat" } });
    fireEvent.click(screen.getByRole("button", { name: "Run via terminal" }));

    const command = writeToTerminal.mock.calls[0][0] as string;
    expect(command).toContain("git show-ref --verify --quiet refs/heads/feat");
    expect(command).not.toContain("2>/dev/null");
    expect(command).not.toContain("--force");
  });

  /// The agent's worktree is on that machine. Asking this one finds nothing — or, if a path happens
  /// to exist here, somebody else's changes.
  it("reads the agent's diff from the machine the agent is on", async () => {
    uncommittedDiffFor.mockResolvedValue("@@ -1 +1 @@\n-a\n+b");
    render(<AgentDiffPanel cwd="/srv/api-rowan" onClose={() => {}} />);

    await waitFor(() => expect(uncommittedDiffFor).toHaveBeenCalledWith(SSH, "/srv/api-rowan"));
    expect(await screen.findByText("+b")).toBeInTheDocument();
  });

  it("keeps a local board on the local commands", async () => {
    getActiveProjectLocation.mockReturnValue(null);
    render(
      <CanvasWorktreePanel
        cwd="/repo"
        assignedWorktree={null}
        onAssign={() => {}}
        onUnassign={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(listWorktreesFor).toHaveBeenCalledWith(null, "/repo"));
  });
});
