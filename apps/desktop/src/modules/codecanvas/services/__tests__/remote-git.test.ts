import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = {
  listGitWorktrees: vi.fn(),
  listGitWorktreesSsh: vi.fn(),
  createGitWorktree: vi.fn(),
  createGitWorktreeSsh: vi.fn(),
  removeGitWorktree: vi.fn(),
  removeGitWorktreeSsh: vi.fn(),
  validateWorktreeBranches: vi.fn(),
  validateWorktreeBranchesSsh: vi.fn(),
  resolveRepoHeadBranch: vi.fn(),
  resolveRepoHeadBranchSsh: vi.fn(),
  gitUncommittedDiff: vi.fn(),
  gitUncommittedDiffSsh: vi.fn(),
};

vi.mock("@/lib/tauri/canvas-git", () => ({
  listGitWorktrees: (...a: unknown[]) => calls.listGitWorktrees(...a),
  listGitWorktreesSsh: (...a: unknown[]) => calls.listGitWorktreesSsh(...a),
  createGitWorktree: (...a: unknown[]) => calls.createGitWorktree(...a),
  createGitWorktreeSsh: (...a: unknown[]) => calls.createGitWorktreeSsh(...a),
  removeGitWorktree: (...a: unknown[]) => calls.removeGitWorktree(...a),
  removeGitWorktreeSsh: (...a: unknown[]) => calls.removeGitWorktreeSsh(...a),
  validateWorktreeBranches: (...a: unknown[]) => calls.validateWorktreeBranches(...a),
  validateWorktreeBranchesSsh: (...a: unknown[]) => calls.validateWorktreeBranchesSsh(...a),
  resolveRepoHeadBranch: (...a: unknown[]) => calls.resolveRepoHeadBranch(...a),
  resolveRepoHeadBranchSsh: (...a: unknown[]) => calls.resolveRepoHeadBranchSsh(...a),
  gitUncommittedDiff: (...a: unknown[]) => calls.gitUncommittedDiff(...a),
  gitUncommittedDiffSsh: (...a: unknown[]) => calls.gitUncommittedDiffSsh(...a),
}));

const git = await import("../remote-git");
const { isolateAgentNode, gitIsolationDepsFor } = await import("../agent-isolation");

const SSH = { kind: "ssh" as const, host: "devbox-vps", user: "root", label: "VPS" };
const TARGET = { host: "devbox-vps", user: "root", port: null };

describe("git on whichever machine the project is", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(calls)) fn.mockResolvedValue([]);
  });

  it("takes the local command when there is no machine", async () => {
    await git.listWorktreesFor(null, "/repo");
    expect(calls.listGitWorktrees).toHaveBeenCalledWith("/repo");
    expect(calls.listGitWorktreesSsh).not.toHaveBeenCalled();
  });

  /// The label is ours, not ssh's — sending it would be an unknown field on the Rust target.
  it("sends the machine without the name we gave it", async () => {
    await git.listWorktreesFor(SSH, "/srv/api");
    expect(calls.listGitWorktreesSsh).toHaveBeenCalledWith(TARGET, "/srv/api");
    expect(calls.listGitWorktrees).not.toHaveBeenCalled();
  });

  it("routes every worktree operation, not just the one that was easy", async () => {
    await git.createWorktreeFor(SSH, "/srv/api", "lotus/team/rowan", "/srv/api-rowan");
    expect(calls.createGitWorktreeSsh).toHaveBeenCalledWith(TARGET, "/srv/api", "lotus/team/rowan", "/srv/api-rowan");

    await git.removeWorktreeFor(SSH, "/srv/api", "/srv/api-rowan");
    expect(calls.removeGitWorktreeSsh).toHaveBeenCalledWith(TARGET, "/srv/api", "/srv/api-rowan");

    await git.validateWorktreeBranchesFor(SSH, "/srv/api", ["a", "b"]);
    expect(calls.validateWorktreeBranchesSsh).toHaveBeenCalledWith(TARGET, "/srv/api", ["a", "b"]);

    await git.resolveHeadBranchFor(SSH, "/srv/api");
    expect(calls.resolveRepoHeadBranchSsh).toHaveBeenCalledWith(TARGET, "/srv/api");

    await git.uncommittedDiffFor(SSH, "/srv/api-rowan");
    expect(calls.gitUncommittedDiffSsh).toHaveBeenCalledWith(TARGET, "/srv/api-rowan");
  });

  it("leaves a board on this machine exactly as it was", async () => {
    await git.createWorktreeFor(undefined, "/repo", "b", "/repo-b");
    await git.removeWorktreeFor(undefined, "/repo", "/repo-b");
    await git.resolveHeadBranchFor(undefined, "/repo");
    await git.uncommittedDiffFor(undefined, "/repo");

    expect(calls.createGitWorktree).toHaveBeenCalledWith("/repo", "b", "/repo-b");
    expect(calls.removeGitWorktree).toHaveBeenCalledWith("/repo", "/repo-b");
    expect(calls.resolveRepoHeadBranch).toHaveBeenCalledWith("/repo");
    expect(calls.gitUncommittedDiff).toHaveBeenCalledWith("/repo");
    expect(calls.createGitWorktreeSsh).not.toHaveBeenCalled();
  });
});

/**
 * ADR 0015's isolation is unchanged by distance — the naming, the slug disambiguation and the base
 * branch are the same work. What must change is *where* the three git calls land.
 */
describe("isolating an agent on a project that lives elsewhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.resolveRepoHeadBranchSsh.mockResolvedValue("main");
    calls.listGitWorktreesSsh.mockResolvedValue([]);
    calls.createGitWorktreeSsh.mockResolvedValue({ path: "/srv/api-rowan", branch: "lotus/tim/rowan", isMain: false });
  });

  it("cuts the worktree on the machine the repo is on, not on this one", async () => {
    const result = await isolateAgentNode(
      { repoPath: "/srv/api", teamLabel: "Tim", agentLabel: "Rowan" },
      gitIsolationDepsFor(SSH),
    );

    expect(result.baseBranch).toBe("main");
    expect(calls.resolveRepoHeadBranchSsh).toHaveBeenCalledWith(TARGET, "/srv/api");
    expect(calls.createGitWorktreeSsh).toHaveBeenCalledWith(TARGET, "/srv/api", result.branch, result.path);
    expect(calls.createGitWorktree).not.toHaveBeenCalled();
    expect(calls.resolveRepoHeadBranch).not.toHaveBeenCalled();
  });

  /// The slugs it disambiguates against have to come from the same machine, or a second agent gets
  /// a branch that already exists there and git refuses the spawn.
  it("disambiguates against the branches that exist on that machine", async () => {
    calls.listGitWorktreesSsh.mockResolvedValue([
      { path: "/srv/api", branch: "main", isMain: true },
      { path: "/srv/api-rowan", branch: "lotus/tim/rowan", isMain: false },
    ]);

    const result = await isolateAgentNode(
      { repoPath: "/srv/api", teamLabel: "Tim", agentLabel: "Rowan" },
      gitIsolationDepsFor(SSH),
    );

    expect(calls.listGitWorktreesSsh).toHaveBeenCalledWith(TARGET, "/srv/api");
    expect(result.branch).not.toBe("lotus/tim/rowan");
    expect(result.branch.startsWith("lotus/tim/rowan")).toBe(true);
  });
});
