import { describe, expect, it } from "vitest";

import {
  buildCliToolLaunch,
  getKnownCliTools,
  getWorkspaceToolActionGroups,
  getWorkspaceToolActions,
  getToolInstallHint,
  mergeCliToolAvailability,
} from "../cli-tools";

describe("cli-tools service", () => {
  it("exposes the supported workspace tools in stable display order", () => {
    const tools = getKnownCliTools();

    expect(tools.map((tool) => tool.id)).toEqual(["lazygit", "lazydocker", "yazi", "zoxide", "delta"]);
    expect(tools.map((tool) => tool.command)).toEqual(["lazygit", "lazydocker", "yazi", "zoxide", "delta"]);
    expect(tools.every((tool) => tool.label && tool.description && tool.installHints.mac)).toBe(true);
  });

  it("exposes workspace actions without treating plain git diff as an installable tool", () => {
    const actions = getWorkspaceToolActions(mergeCliToolAvailability([
      { id: "lazygit", installed: true },
      { id: "delta", installed: false },
    ]));

    expect(actions.map((action) => action.id)).toEqual([
      "lazygit",
      "lazydocker",
      "yazi",
      "zoxide",
      "delta",
      "git-diff",
    ]);
    expect(actions.find((action) => action.id === "lazygit")).toMatchObject({
      installed: true,
      launchable: true,
      installable: true,
    });
    expect(actions.find((action) => action.id === "delta")).toMatchObject({
      installed: false,
      launchable: false,
      installable: true,
    });
    expect(actions.find((action) => action.id === "git-diff")).toMatchObject({
      label: "Git Diff",
      command: "git diff",
      installed: true,
      launchable: true,
      installable: false,
    });
  });

  it("can keep SSH workspace tools launchable when detection is inconclusive", () => {
    const actions = getWorkspaceToolActions(mergeCliToolAvailability([
      { id: "lazydocker", installed: false },
    ]), { allowMissingLaunch: true });

    expect(actions.find((action) => action.id === "lazydocker")).toMatchObject({
      installed: false,
      launchable: true,
      installable: true,
    });
  });

  it("groups workspace actions by workflow priority", () => {
    const groups = getWorkspaceToolActionGroups(mergeCliToolAvailability([
      { id: "lazygit", installed: true },
      { id: "lazydocker", installed: true },
      { id: "delta", installed: true },
      { id: "yazi", installed: true },
      { id: "zoxide", installed: true },
    ]));

    expect(groups.map((group) => group.id)).toEqual(["review", "docker", "navigate"]);
    expect(groups.find((group) => group.id === "review")?.actions.map((action) => action.id)).toEqual([
      "git-diff",
      "lazygit",
      "delta",
    ]);
    expect(groups.find((group) => group.id === "docker")?.actions.map((action) => action.id)).toEqual([
      "lazydocker",
    ]);
    expect(groups.find((group) => group.id === "navigate")?.actions.map((action) => action.id)).toEqual([
      "yazi",
      "zoxide",
    ]);
  });

  it("merges backend availability without dropping product metadata", () => {
    const availability = mergeCliToolAvailability([
      { id: "lazygit", installed: true, version: "lazygit version 0.44.1" },
      { id: "delta", installed: false },
    ]);

    expect(availability.find((tool) => tool.id === "lazygit")).toMatchObject({
      label: "LazyGit",
      command: "lazygit",
      installed: true,
      version: "lazygit version 0.44.1",
    });
    expect(availability.find((tool) => tool.id === "delta")).toMatchObject({
      label: "Delta",
      installed: false,
    });
    expect(availability.find((tool) => tool.id === "yazi")).toMatchObject({
      installed: false,
    });
  });

  it("builds structured launch commands for terminal panes", () => {
    const context = {
      cwd: "/repo/packages/app",
      repoRoot: "/repo",
    };

    expect(buildCliToolLaunch("lazygit", context)).toEqual({
      cwd: "/repo",
      command: "lazygit",
      label: "LazyGit",
    });
    expect(buildCliToolLaunch("yazi", context)).toEqual({
      cwd: "/repo/packages/app",
      command: "yazi",
      label: "Yazi",
    });
    expect(buildCliToolLaunch("lazydocker", context)).toEqual({
      cwd: "/repo/packages/app",
      command: "lazydocker",
      label: "LazyDocker",
    });
    expect(buildCliToolLaunch("delta", context)).toEqual({
      cwd: "/repo",
      command: "git -c core.pager=delta diff",
      label: "Delta Diff",
    });
    expect(buildCliToolLaunch("git-diff", context)).toEqual({
      cwd: "/repo",
      command: "git diff",
      label: "Git Diff",
    });
  });

  it("falls back to plain git diff when Delta is unavailable", () => {
    expect(buildCliToolLaunch("delta", {
      cwd: "/repo",
      repoRoot: "/repo",
      availability: { delta: false },
    })).toMatchObject({
      command: "git diff",
      label: "Git Diff",
    });
  });

  it("returns platform-specific install hints", () => {
    expect(getToolInstallHint("lazygit", "mac")).toBe("brew install lazygit");
    expect(getToolInstallHint("lazydocker", "mac")).toBe("brew install jesseduffield/lazydocker/lazydocker");
    expect(getToolInstallHint("lazydocker", "windows")).toBe("scoop install lazydocker");
    expect(getToolInstallHint("yazi", "windows")).toContain("winget install");
    expect(getToolInstallHint("zoxide", "linux")).toContain("package manager");
  });
});
