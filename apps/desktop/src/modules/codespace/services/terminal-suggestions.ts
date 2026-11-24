export interface TerminalSuggestion {
  id: string;
  command: string;
  source: "preset" | "history";
  description?: string;
}

interface SuggestionQuery {
  cwd: string;
  input: string;
  normalizedInput: string;
  mode: "command" | "full";
}

interface SuggestionProvider {
  getSuggestions: (query: SuggestionQuery, history: string[]) => TerminalSuggestion[];
}

type CachedHistoryEntry = {
  signature: string;
  entries: Array<{ command: string; normalized: string }>;
};

const MAX_SUGGESTIONS = 5;

type SuggestionSeed = Omit<TerminalSuggestion, "id"> & {
  aliases?: string[];
};

const ROOT_COMMAND_PRIORITY = [
  "git",
  "cd",
  "ls",
  "pwd",
  "rg",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "rm",
  "cat",
  "clear",
  "bun",
  "npm",
  "pnpm",
  "uv",
  "python",
  "node",
  "cargo",
  "docker",
  "lsof",
  "lazygit",
  "yazi",
  "z",
  "zi",
  "claude",
  "codex",
  "ccs",
  "csp",
] as const;

const ALLOWED_HISTORY_ROOTS = new Set(ROOT_COMMAND_PRIORITY);

const PRESET_SUGGESTION_SEEDS: SuggestionSeed[] = [
  {
    command: "git status",
    source: "preset",
    description: "Check tracked changes in the current repository.",
    aliases: ["git st"],
  },
  {
    command: "git checkout",
    source: "preset",
    description: "Switch to another branch or restore a file version.",
    aliases: ["git co", "git ch"],
  },
  {
    command: "git switch",
    source: "preset",
    description: "Switch branches using the modern git subcommand.",
  },
  {
    command: "git pull",
    source: "preset",
    description: "Fetch and merge changes from the tracked remote branch.",
  },
  {
    command: "git push",
    source: "preset",
    description: "Push local commits to the tracked remote branch.",
  },
  {
    command: "git add .",
    source: "preset",
    description: "Stage all changed files in the current directory.",
  },
  {
    command: "git commit -m \"\"",
    source: "preset",
    description: "Create a commit with a message.",
  },
  {
    command: "git diff",
    source: "preset",
    description: "Inspect unstaged changes.",
  },
  {
    command: "git log --oneline --graph --decorate -10",
    source: "preset",
    description: "Review recent branch history in a compact format.",
  },
  {
    command: "git branch",
    source: "preset",
    description: "List local branches.",
  },
  {
    command: "git stash",
    source: "preset",
    description: "Temporarily save uncommitted changes.",
  },
  {
    command: "ls",
    source: "preset",
    description: "List files in the current directory.",
  },
  {
    command: "ls -la",
    source: "preset",
    description: "List all files with details, including hidden ones.",
  },
  {
    command: "cd ..",
    source: "preset",
    description: "Move to the parent directory.",
  },
  {
    command: "cd ~/",
    source: "preset",
    description: "Jump to the home directory.",
  },
  {
    command: "pwd",
    source: "preset",
    description: "Print the current working directory.",
  },
  {
    command: "rg ",
    source: "preset",
    description: "Search file contents recursively with ripgrep.",
  },
  {
    command: "rg --files",
    source: "preset",
    description: "List files tracked by ripgrep for fast filtering.",
  },
  {
    command: "mkdir ",
    source: "preset",
    description: "Create a new directory.",
  },
  {
    command: "touch ",
    source: "preset",
    description: "Create a file or update its timestamp.",
  },
  {
    command: "cp ",
    source: "preset",
    description: "Copy files or directories.",
  },
  {
    command: "mv ",
    source: "preset",
    description: "Move or rename files and directories.",
  },
  {
    command: "rm ",
    source: "preset",
    description: "Remove files or directories.",
  },
  {
    command: "cat ",
    source: "preset",
    description: "Print file contents to the terminal.",
  },
  {
    command: "clear",
    source: "preset",
    description: "Clear the terminal screen.",
  },
  {
    command: "bun install",
    source: "preset",
    description: "Install dependencies with Bun.",
  },
  {
    command: "bun run dev",
    source: "preset",
    description: "Start the development server with Bun.",
  },
  {
    command: "npm install",
    source: "preset",
    description: "Install dependencies with npm.",
  },
  {
    command: "npm run dev",
    source: "preset",
    description: "Start the development server with npm.",
  },
  {
    command: "pnpm install",
    source: "preset",
    description: "Install dependencies with pnpm.",
  },
  {
    command: "pnpm dev",
    source: "preset",
    description: "Start the development server with pnpm.",
  },
  {
    command: "uv run ",
    source: "preset",
    description: "Run a command inside the uv-managed Python environment.",
  },
  {
    command: "python ",
    source: "preset",
    description: "Run Python.",
  },
  {
    command: "node ",
    source: "preset",
    description: "Run Node.js.",
  },
  {
    command: "cargo test",
    source: "preset",
    description: "Run Rust tests.",
  },
  {
    command: "cargo run",
    source: "preset",
    description: "Build and run the current Rust package.",
  },
  {
    command: "docker ps",
    source: "preset",
    description: "List running Docker containers.",
  },
  {
    command: "docker compose up",
    source: "preset",
    description: "Start services from a Docker Compose project.",
  },
  {
    command: "docker compose down",
    source: "preset",
    description: "Stop services from a Docker Compose project.",
  },
  {
    command: "lsof -i :3000",
    source: "preset",
    description: "Inspect which process is using port 3000.",
  },
  {
    command: "lazygit",
    source: "preset",
    description: "Open the Git terminal UI for reviewing changes.",
  },
  {
    command: "lazydocker",
    source: "preset",
    description: "Open the Docker terminal UI for containers and compose services.",
  },
  {
    command: "yazi",
    source: "preset",
    description: "Open the terminal file browser in this directory.",
  },
  {
    command: "z ",
    source: "preset",
    description: "Jump to a frequent directory with zoxide.",
  },
  {
    command: "zi",
    source: "preset",
    description: "Open zoxide's interactive directory picker.",
  },
  {
    command: "git -c core.pager=delta diff",
    source: "preset",
    description: "Review working tree changes with Delta when installed.",
    aliases: ["delta diff", "diff"],
  },
  {
    command: "git -c core.pager=delta diff --staged",
    source: "preset",
    description: "Review staged changes with Delta when installed.",
    aliases: ["delta staged", "diff staged"],
  },
  {
    command: "claude",
    source: "preset",
    description: "Launch Claude CLI.",
  },
  {
    command: "claude --dangerously-skip-permissions",
    source: "preset",
    description: "Launch Claude CLI without interactive permission prompts.",
  },
  {
    command: "codex",
    source: "preset",
    description: "Launch Codex CLI.",
  },
  {
    command: "codex --dangerously-skip-permissions",
    source: "preset",
    description: "Launch Codex CLI without interactive permission prompts.",
  },
  {
    command: "codex exec --skip-git-repo-check --color never",
    source: "preset",
    description: "Run Codex in workspace-safe exec mode.",
  },
  {
    command: "ccs hss",
    source: "preset",
    description: "Run the CCS Claude-compatible wrapper.",
  },
  {
    command: "ccs hss --dangerously-skip-permissions",
    source: "preset",
    description: "Run CCS HSS without interactive permission prompts.",
  },
  {
    command: "csp",
    source: "preset",
    description: "Launch CSP command.",
  },
  {
    command: "csp --dangerously-skip-permissions",
    source: "preset",
    description: "Launch CSP without interactive permission prompts.",
  },
];

const PRESET_COMMAND_ORDER = new Map(
  PRESET_SUGGESTION_SEEDS.map((suggestion, index) => [suggestion.command, index]),
);

const historyCache = new Map<string, CachedHistoryEntry>();

function normalize(input: string): string {
  return input.trim().toLowerCase();
}

function buildHistorySignature(history: string[]): string {
  return history.join("\u0000");
}

function getCachedHistoryEntries(cwd: string, history: string[]): Array<{ command: string; normalized: string }> {
  const signature = buildHistorySignature(history);
  const cached = historyCache.get(cwd);
  if (cached && cached.signature === signature) {
    return cached.entries;
  }

  const entries = history
    .slice()
    .reverse()
    .map((command) => ({
      command,
      normalized: command.toLowerCase(),
    }));

  historyCache.set(cwd, { signature, entries });
  return entries;
}

function dedupeSuggestions(suggestions: TerminalSuggestion[]): TerminalSuggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (seen.has(suggestion.command)) {
      return false;
    }
    seen.add(suggestion.command);
    return true;
  });
}

function rootCommandOf(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function sortSuggestions(suggestions: TerminalSuggestion[]): TerminalSuggestion[] {
  return suggestions.slice().sort((left, right) => {
    const sourcePriority = (source: TerminalSuggestion["source"]) => (source === "preset" ? 0 : 1);
    const sourceDelta = sourcePriority(left.source) - sourcePriority(right.source);
    if (sourceDelta !== 0) {
      return sourceDelta;
    }

    const rootPriority = (command: string) => {
      const index = ROOT_COMMAND_PRIORITY.indexOf(rootCommandOf(command) as (typeof ROOT_COMMAND_PRIORITY)[number]);
      return index === -1 ? ROOT_COMMAND_PRIORITY.length : index;
    };

    const rootDelta = rootPriority(left.command) - rootPriority(right.command);
    if (rootDelta !== 0) {
      return rootDelta;
    }

    if (left.source === "preset" && right.source === "preset") {
      return (PRESET_COMMAND_ORDER.get(left.command) ?? Number.MAX_SAFE_INTEGER)
        - (PRESET_COMMAND_ORDER.get(right.command) ?? Number.MAX_SAFE_INTEGER);
    }

    return left.command.localeCompare(right.command);
  });
}

function buildSuggestionQuery(input: string, cwd = ""): SuggestionQuery | null {
  const normalizedInput = normalize(input);
  if (!normalizedInput) {
    return null;
  }

  return {
    cwd,
    input,
    normalizedInput,
    mode: normalizedInput.includes(" ") ? "full" : "command",
  };
}

const presetProvider: SuggestionProvider = {
  getSuggestions(query) {
    return PRESET_SUGGESTION_SEEDS
      .filter((suggestion) => {
        const normalizedCommand = suggestion.command.toLowerCase();
        if (normalizedCommand.startsWith(query.normalizedInput)) {
          return true;
        }

        return suggestion.aliases?.some((alias) => alias.startsWith(query.normalizedInput)) ?? false;
      })
      .map((suggestion) => ({
        ...suggestion,
        id: `preset:${suggestion.command}`,
      }));
  },
};

const historyProvider: SuggestionProvider = {
  getSuggestions(query, history) {
    const entries = getCachedHistoryEntries(query.cwd, history);

    return entries
      .filter((entry) => ALLOWED_HISTORY_ROOTS.has(rootCommandOf(entry.command) as (typeof ROOT_COMMAND_PRIORITY)[number]))
      .filter((entry) => entry.normalized.startsWith(query.normalizedInput))
      .map((entry) => ({
        id: `history:${entry.command}`,
        command: entry.command,
        source: "history" as const,
        description: "Recent command from this workspace.",
      }));
  },
};

const providersByMode: Record<SuggestionQuery["mode"], SuggestionProvider[]> = {
  command: [presetProvider, historyProvider],
  full: [presetProvider, historyProvider],
};

export function getTerminalSuggestions(
  input: string,
  history: string[],
  options?: { cwd?: string },
): TerminalSuggestion[] {
  const query = buildSuggestionQuery(input, options?.cwd ?? "");
  if (!query) {
    return [];
  }

  const providers = providersByMode[query.mode];
  const suggestions = providers.flatMap((provider) => provider.getSuggestions(query, history));

  return sortSuggestions(dedupeSuggestions(suggestions)).slice(0, MAX_SUGGESTIONS);
}

export function getSuggestionRemainder(input: string, suggestion: string): string {
  if (!normalize(input)) {
    return "";
  }

  if (!suggestion.toLowerCase().startsWith(input.toLowerCase())) {
    return "";
  }

  return suggestion.slice(input.length);
}

export function clearTerminalSuggestionCachesForTest(): void {
  historyCache.clear();
}
