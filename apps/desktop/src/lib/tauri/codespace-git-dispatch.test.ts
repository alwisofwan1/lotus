import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: mocks.isTauri,
  tauriInvoke: mocks.invoke,
}));

import {
  codespaceGitAiSuggestCommitFor,
  codespaceGitCommitFor,
  codespaceGitDiffFileContentFor,
  codespaceGitDiffFileFor,
  codespaceGitDiscardAllChangesFor,
  codespaceGitDiscardFileFor,
  codespaceGitPanelRefreshFor,
  codespaceGitPushFor,
  codespaceGitRepoSummaryFor,
  codespaceGitStageAllFor,
  codespaceGitStageFileFor,
  codespaceGitStatusFor,
  codespaceGitUnstageAllFor,
  codespaceGitUnstageFileFor,
  type CodeSpaceStoredWorkspaceLocation,
} from "@/lib/tauri/codespace";
const SSH: CodeSpaceStoredWorkspaceLocation = {
  kind: "ssh",
  host: "devbox-vps",
  user: "alwi",
  port: 2222,
  remoteCwd: "/srv/repo",
};

const LOCAL: CodeSpaceStoredWorkspaceLocation = {
  kind: "local",
  cwd: "/Users/alwi/repo",
};

const TARGET = { host: "devbox-vps", user: "alwi", port: 2222 };

describe("codespaceGitStatusFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue([]);
  });

  it("dispatches to status_ssh for ssh workspaces", async () => {
    await codespaceGitStatusFor(SSH);
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_status_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
    });
  });

  it("dispatches to status (local) for local workspaces", async () => {
    await codespaceGitStatusFor(LOCAL);
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_status", {
      repoRoot: "/Users/alwi/repo",
    });
  });

  it("respects repoRoot override on ssh workspaces (e.g. nested repo)", async () => {
    await codespaceGitStatusFor(SSH, { repoRoot: "/srv/repo/sub-package" });
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_status_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo/sub-package",
    });
  });

  it("ignores a non-absolute repoRoot override and falls back to location.remoteCwd", async () => {
    await codespaceGitStatusFor(SSH, { repoRoot: "~" });
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_status_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
    });
  });

  it("uses repoRoot override as the ssh root when the persisted location has no remoteCwd", async () => {
    const incomplete: CodeSpaceStoredWorkspaceLocation = {
      kind: "ssh",
      host: "devbox-vps",
      user: "alwi",
      port: 2222,
    };

    await codespaceGitStatusFor(incomplete, { repoRoot: "/srv/repo" });

    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_status_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
    });
  });

  it("returns empty list when no location and no override", async () => {
    const result = await codespaceGitStatusFor(null);
    expect(result).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("codespaceGitRepoSummaryFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ branch: "main", head: null, upstream: null, ahead: 0, behind: 0 });
  });

  it("dispatches to repo_summary_ssh for ssh workspaces", async () => {
    await codespaceGitRepoSummaryFor(SSH);
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_repo_summary_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
    });
  });

  it("dispatches to repo_summary (local) for local workspaces", async () => {
    await codespaceGitRepoSummaryFor(LOCAL);
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_repo_summary", {
      repoRoot: "/Users/alwi/repo",
    });
  });
});

describe("codespaceGitStageFileFor / UnstageFileFor / CommitFor", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("stage-file routes through ssh and forwards filePath", async () => {
    await codespaceGitStageFileFor(SSH, "src/main.rs");
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_stage_file_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
      filePath: "src/main.rs",
    });
  });

  it("stage-file routes through local for local workspaces", async () => {
    await codespaceGitStageFileFor(LOCAL, "src/main.rs");
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_stage_file", {
      repoRoot: "/Users/alwi/repo",
      filePath: "src/main.rs",
    });
  });

  it("unstage-file routes through ssh", async () => {
    await codespaceGitUnstageFileFor(SSH, "src/main.rs");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "codespace_git_unstage_file_ssh",
      expect.objectContaining({ filePath: "src/main.rs" }),
    );
  });

  it("commit forwards message to ssh command", async () => {
    await codespaceGitCommitFor(SSH, "feat: add ssh git");
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_commit_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
      message: "feat: add ssh git",
    });
  });
});

describe("stage-all / unstage-all / discard-all / push", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it.each([
    ["stage-all-ssh", () => codespaceGitStageAllFor(SSH), "codespace_git_stage_all_ssh"],
    ["unstage-all-ssh", () => codespaceGitUnstageAllFor(SSH), "codespace_git_unstage_all_ssh"],
    [
      "discard-all-ssh",
      () => codespaceGitDiscardAllChangesFor(SSH),
      "codespace_git_discard_all_changes_ssh",
    ],
    ["push-ssh", () => codespaceGitPushFor(SSH), "codespace_git_push_ssh"],
  ])("ssh: %s dispatches to the right command", async (_, run, expected) => {
    await run();
    expect(mocks.invoke).toHaveBeenCalledWith(
      expected,
      expect.objectContaining({ target: TARGET, repoRoot: "/srv/repo" }),
    );
  });

  it.each([
    ["stage-all-local", () => codespaceGitStageAllFor(LOCAL), "codespace_git_stage_all"],
    ["unstage-all-local", () => codespaceGitUnstageAllFor(LOCAL), "codespace_git_unstage_all"],
    [
      "discard-all-local",
      () => codespaceGitDiscardAllChangesFor(LOCAL),
      "codespace_git_discard_all_changes",
    ],
    ["push-local", () => codespaceGitPushFor(LOCAL), "codespace_git_push"],
  ])("local: %s dispatches to the right command", async (_, run, expected) => {
    await run();
    expect(mocks.invoke).toHaveBeenCalledWith(expected, { repoRoot: "/Users/alwi/repo" });
  });

  it("throws when neither location nor repoRoot is provided to a mutation", async () => {
    await expect(codespaceGitStageAllFor(null)).rejects.toThrow();
    await expect(codespaceGitCommitFor(null, "msg")).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("codespaceGitPanelRefreshFor", () => {
  const REFRESH_RESULT = {
    summary: { branch: "main", head: "abc1234", upstream: "origin/main", ahead: 0, behind: 0 },
    files: [],
  };

  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(REFRESH_RESULT);
  });

  it("dispatches single SSH call for ssh workspaces", async () => {
    const result = await codespaceGitPanelRefreshFor(SSH);
    expect(result).toEqual(REFRESH_RESULT);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_panel_refresh_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
    });
  });

  it("dispatches single local call for local workspaces", async () => {
    await codespaceGitPanelRefreshFor(LOCAL);
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_panel_refresh", {
      repoRoot: "/Users/alwi/repo",
    });
  });

  it("returns null when location is null", async () => {
    const result = await codespaceGitPanelRefreshFor(null);
    expect(result).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("per-file discard, diff and AI suggest (Editor Revamp 15)", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue("");
  });

  it("discard-file routes through ssh and local", async () => {
    await codespaceGitDiscardFileFor(SSH, "/srv/repo/a.ts");
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_discard_file_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
      filePath: "/srv/repo/a.ts",
    });
    await codespaceGitDiscardFileFor(LOCAL, "/Users/alwi/repo/a.ts");
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_discard_file", {
      repoRoot: "/Users/alwi/repo",
      filePath: "/Users/alwi/repo/a.ts",
    });
  });

  it("diff and diff content go over ssh for ssh workspaces", async () => {
    await codespaceGitDiffFileFor(SSH, "/srv/repo/a.ts", "staged");
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_diff_file_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
      filePath: "/srv/repo/a.ts",
      diffTarget: "staged",
    });
    await codespaceGitDiffFileContentFor(SSH, "/srv/repo/a.ts", "unstaged");
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_diff_file_content_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
      filePath: "/srv/repo/a.ts",
      diffTarget: "unstaged",
    });
  });

  it("diff stays local for local workspaces", async () => {
    await codespaceGitDiffFileFor(LOCAL, "/Users/alwi/repo/a.ts", "unstaged", { repoRoot: "/Users/alwi/repo" });
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_diff_file", {
      repoRoot: "/Users/alwi/repo",
      filePath: "/Users/alwi/repo/a.ts",
      target: "unstaged",
    });
  });

  it("AI suggest reads the staged diff over ssh for ssh workspaces", async () => {
    mocks.invoke.mockResolvedValue("feat: x");
    await expect(codespaceGitAiSuggestCommitFor(SSH)).resolves.toBe("feat: x");
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_ai_suggest_commit_ssh", {
      target: TARGET,
      repoRoot: "/srv/repo",
    });
    await codespaceGitAiSuggestCommitFor(LOCAL);
    expect(mocks.invoke).toHaveBeenCalledWith("codespace_git_ai_suggest_commit", { repoRoot: "/Users/alwi/repo" });
  });
});
