import type { AgentRunnerType } from "./agent-runner";

export type AgentRunnerReadinessSignal =
  | { state: "pending" }
  | { state: "ready" }
  | { state: "failed"; message: string };

export interface AgentRunnerReadinessAdapter {
  runner: AgentRunnerType;
  timeoutMs: number;
  readyPatterns: RegExp[];
}

const STARTUP_FAILURES: { pattern: RegExp; message: string }[] = [
  { pattern: /command not found/i, message: "Agent runner failed to start: command not found" },
  { pattern: /no such file or directory/i, message: "Agent runner failed to start: executable not found" },
  { pattern: /permission denied/i, message: "Agent runner failed to start: permission denied" },
  { pattern: /unknown option|unrecognized option|invalid option/i, message: "Agent runner failed to start: invalid runner option" },
];

const CLAUDE_READY_PATTERNS = [
  /\?\s*for shortcuts/i,
  /bypass permissions on/i,
  // Claude Code v2.x TUI footer. "shift+tab to cycle" is the permission-mode cycle hint shown in
  // EVERY mode (default/acceptEdits/plan/bypass), so it survives banner rewordings and the cases
  // where "bypass permissions on" is absent because the session isn't in bypass mode.
  /shift\s*\+\s*tab to cycle/i,
  /for agents/i,
  /claude code.*ready/i,
];

const ADAPTERS: Record<AgentRunnerType, AgentRunnerReadinessAdapter> = {
  claude: {
    runner: "claude",
    timeoutMs: 45_000,
    readyPatterns: CLAUDE_READY_PATTERNS,
  },
  ccs: {
    runner: "ccs",
    timeoutMs: 45_000,
    readyPatterns: CLAUDE_READY_PATTERNS,
  },
  csp: {
    runner: "csp",
    timeoutMs: 45_000,
    readyPatterns: CLAUDE_READY_PATTERNS,
  },
  codex: {
    runner: "codex",
    timeoutMs: 60_000,
    readyPatterns: [
      // Newer Codex TUI (gpt-5.x): the live status bar + footer hints only render once the prompt is
      // interactive — the most reliable "ready" signals across builds.
      /context\s+\d+%\s+used/i,
      /bypass permissions on/i,
      /\/model to change/i,
      // Older Codex builds.
      /ask codex to do anything/i,
      /codex.*ready/i,
      /\bcodex\b[\s\S]{0,120}\n[>›▌]/i,
    ],
  },
  cursor: {
    runner: "cursor",
    timeoutMs: 60_000,
    readyPatterns: [
      /cursor agent/i,
      /cursor.*ready/i,
      /\byolo\b/i,
    ],
  },
  custom: {
    runner: "custom",
    timeoutMs: 15_000,
    readyPatterns: [/[$%#>]\s*$/m],
  },
};

export function getAgentRunnerReadinessAdapter(runner: AgentRunnerType = "claude"): AgentRunnerReadinessAdapter {
  return ADAPTERS[runner] ?? ADAPTERS.claude;
}

export interface AgentRunnerReadinessTracker {
  readonly adapter: AgentRunnerReadinessAdapter;
  observe(data: string): AgentRunnerReadinessSignal;
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function createAgentRunnerReadinessTracker(runner: AgentRunnerType = "claude"): AgentRunnerReadinessTracker {
  const adapter = getAgentRunnerReadinessAdapter(runner);
  let buffer = "";

  return {
    adapter,
    observe(data: string): AgentRunnerReadinessSignal {
      buffer = `${buffer}${data}`.slice(-12_000);
      const clean = stripAnsi(buffer);
      // Box-drawn TUIs paint their footer with interspersed cursor-move sequences and line wraps;
      // stripAnsi removes the escapes but not the layout, so a hint like "bypass permissions on"
      // can land split across whitespace/newlines. Test a whitespace-collapsed view too so that
      // fragmentation never defeats a genuine match. Patterns that intentionally use \n/$ still
      // match against `clean` (the OR keeps both behaviors).
      const collapsed = clean.replace(/\s+/g, " ");
      const matches = (pattern: RegExp) => pattern.test(clean) || pattern.test(collapsed);
      for (const failure of STARTUP_FAILURES) {
        if (matches(failure.pattern)) return { state: "failed", message: failure.message };
      }
      if (adapter.readyPatterns.some(matches)) return { state: "ready" };
      return { state: "pending" };
    },
  };
}
