export type CliToolId = "lazygit" | "lazydocker" | "yazi" | "zoxide" | "delta";
export type WorkspaceToolActionId = CliToolId | "git-diff";
export type CliToolLaunchTarget = "new-pane" | "current-pane";
export type CliToolPlatform = "mac" | "linux" | "windows";

export interface CliToolDefinition {
  id: CliToolId;
  label: string;
  command: string;
  description: string;
  installHints: Record<CliToolPlatform, string>;
  caveat?: string;
}

export interface CliToolBackendAvailability {
  id: CliToolId;
  installed: boolean;
  version?: string;
}

export interface CliToolAvailability extends CliToolDefinition {
  installed: boolean;
  version?: string;
}

export interface WorkspaceToolAction {
  id: WorkspaceToolActionId;
  label: string;
  command: string;
  description: string;
  installed: boolean;
  launchable: boolean;
  installable: boolean;
  version?: string;
  caveat?: string;
}

export interface WorkspaceToolActionGroup {
  id: "review" | "docker" | "navigate";
  label: string;
  actions: WorkspaceToolAction[];
}

export interface CliToolLaunchContext {
  cwd: string;
  repoRoot?: string | null;
  availability?: Partial<Record<CliToolId, boolean>>;
}

export interface CliToolLaunch {
  cwd: string;
  command: string;
  label: string;
}

export interface WorkspaceToolActionOptions {
  allowMissingLaunch?: boolean;
}

const KNOWN_CLI_TOOLS: CliToolDefinition[] = [
  {
    id: "lazygit",
    label: "LazyGit",
    command: "lazygit",
    description: "Review staged and unstaged Git changes in a terminal UI.",
    installHints: {
      mac: "brew install lazygit",
      linux: "Install lazygit with your package manager, or see https://github.com/jesseduffield/lazygit.",
      windows: "winget install JesseDuffield.lazygit",
    },
  },
  {
    id: "lazydocker",
    label: "LazyDocker",
    command: "lazydocker",
    description: "Inspect and manage Docker containers, images, volumes, and Compose services.",
    installHints: {
      mac: "brew install jesseduffield/lazydocker/lazydocker",
      linux: "brew install jesseduffield/lazydocker/lazydocker",
      windows: "scoop install lazydocker",
    },
    caveat: "Requires Docker to be installed and the Docker daemon to be reachable.",
  },
  {
    id: "yazi",
    label: "Yazi",
    command: "yazi",
    description: "Browse, preview, rename, and move files from a terminal pane.",
    installHints: {
      mac: "brew install yazi",
      linux: "Install yazi with your package manager, or see https://yazi-rs.github.io/docs/installation.",
      windows: "winget install sxyazi.yazi",
    },
    caveat: "Image previews depend on terminal protocol support and may fall back to text previews.",
  },
  {
    id: "zoxide",
    label: "Zoxide",
    command: "zoxide",
    description: "Jump to frequent workspace folders without leaving CodeSpace.",
    installHints: {
      mac: "brew install zoxide",
      linux: "Install zoxide with your package manager, then initialize it in your shell profile.",
      windows: "winget install ajeetdsouza.zoxide",
    },
    caveat: "The z and zi shortcuts require shell integration in your login shell.",
  },
  {
    id: "delta",
    label: "Delta",
    command: "delta",
    description: "Render Git diffs with syntax-aware highlighting.",
    installHints: {
      mac: "brew install git-delta",
      linux: "Install git-delta with your package manager.",
      windows: "winget install dandavison.delta",
    },
  },
];

const TOOL_BY_ID = new Map(KNOWN_CLI_TOOLS.map((tool) => [tool.id, tool]));

export function getKnownCliTools(): CliToolDefinition[] {
  return KNOWN_CLI_TOOLS.map((tool) => ({ ...tool, installHints: { ...tool.installHints } }));
}

export function getToolInstallHint(toolId: CliToolId, platform: CliToolPlatform): string {
  return TOOL_BY_ID.get(toolId)?.installHints[platform] ?? "";
}

export function mergeCliToolAvailability(
  backendAvailability: CliToolBackendAvailability[],
): CliToolAvailability[] {
  const availabilityById = new Map(backendAvailability.map((tool) => [tool.id, tool]));

  return KNOWN_CLI_TOOLS.map((definition) => {
    const backend = availabilityById.get(definition.id);
    return {
      ...definition,
      installHints: { ...definition.installHints },
      installed: backend?.installed ?? false,
      version: backend?.version,
    };
  });
}

export function getWorkspaceToolActions(
  tools: CliToolAvailability[],
  options: WorkspaceToolActionOptions = {},
): WorkspaceToolAction[] {
  const actions = tools.map((tool) => ({
    id: tool.id,
    label: tool.label,
    command: tool.command,
    description: tool.description,
    installed: tool.installed,
    launchable: tool.installed || Boolean(options.allowMissingLaunch),
    installable: true,
    version: tool.version,
    caveat: tool.caveat,
  }));

  return [
    ...actions,
    {
      id: "git-diff",
      label: "Git Diff",
      command: "git diff",
      description: "Review working tree changes with plain Git diff output.",
      installed: true,
      launchable: true,
      installable: false,
    },
  ];
}

export function getWorkspaceToolActionGroups(
  tools: CliToolAvailability[],
  options: WorkspaceToolActionOptions = {},
): WorkspaceToolActionGroup[] {
  const actionsById = new Map(getWorkspaceToolActions(tools, options).map((action) => [action.id, action]));
  const actionFor = (id: WorkspaceToolActionId) => actionsById.get(id);
  const reviewActionIds: WorkspaceToolActionId[] = ["git-diff", "lazygit", "delta"];
  const dockerActionIds: WorkspaceToolActionId[] = ["lazydocker"];
  const navigateActionIds: WorkspaceToolActionId[] = ["yazi", "zoxide"];

  return [
    {
      id: "review",
      label: "Review",
      actions: reviewActionIds.map(actionFor).filter((action): action is WorkspaceToolAction => Boolean(action)),
    },
    {
      id: "docker",
      label: "Docker",
      actions: dockerActionIds.map(actionFor).filter((action): action is WorkspaceToolAction => Boolean(action)),
    },
    {
      id: "navigate",
      label: "Navigate",
      actions: navigateActionIds.map(actionFor).filter((action): action is WorkspaceToolAction => Boolean(action)),
    },
  ];
}

export function buildCliToolLaunch(
  toolId: WorkspaceToolActionId,
  context: CliToolLaunchContext,
): CliToolLaunch {
  const repoCwd = context.repoRoot || context.cwd;

  switch (toolId) {
    case "lazygit":
      return {
        cwd: repoCwd,
        command: "lazygit",
        label: "LazyGit",
      };
    case "yazi":
      return {
        cwd: context.cwd,
        command: "yazi",
        label: "Yazi",
      };
    case "lazydocker":
      return {
        cwd: context.cwd,
        command: "lazydocker",
        label: "LazyDocker",
      };
    case "zoxide":
      return {
        cwd: context.cwd,
        command: "zi",
        label: "Zoxide Jump",
      };
    case "delta": {
      const hasDelta = context.availability?.delta ?? true;
      return {
        cwd: repoCwd,
        command: hasDelta ? "git -c core.pager=delta diff" : "git diff",
        label: hasDelta ? "Delta Diff" : "Git Diff",
      };
    }
    case "git-diff":
      return {
        cwd: repoCwd,
        command: "git diff",
        label: "Git Diff",
      };
  }
}
