import type { ProviderId } from "@/modules/codespace/components/types";
import catalog from "@/agents.json";

export type AgentSpec = {
  id: ProviderId;
  displayName: string;
  description: string;
  command: string[];
  isHeadless: boolean;
  /** When true, CLI supports `--append-system-prompt <text>`. */
  supportsAppendSystemPrompt?: boolean;
  /** Vendor mark in `public/assets/ai-logo/`. Absent = the generic mark, never someone else's. */
  logo?: string;
  /** Vendor colour for the mark (design-system.css `--ai-*`); absent = the ink, which follows the theme. */
  tint?: string;
  /** The SVG carries the vendor's own multi-colour artwork; a mask would flatten it. */
  fullColourLogo?: boolean;
};

const LOGO = {
  claude: "/assets/ai-logo/Claude.svg",
  openai: "/assets/ai-logo/ChatGPT.svg",
} as const;

type CatalogAgent = (typeof catalog.agents)[number] & {
  launchFlags?: string;
  tint?: string;
  fullColourLogo?: boolean;
  startErrors?: string[];
  programStatus?: boolean;
  hooks?: "all" | "tools";
};

/**
 * Which turn facts an agent reports, from agents.json — the one table Rust reads too
 * (`agent_catalog.rs`):
 * - `hooks: "all"` — Lotus hooks report every step and the turn end (claude, codex).
 * - `hooks: "tools"` — tool steps only, no turn end (cursor).
 * - `programStatus` — OSC 7501 from the pane's own PTY, read by Rust (grok, pi, agy).
 * Anything else reports nothing, and the pane falls back to PTY inference.
 */
export function agentTurnReports(
  id: string | null | undefined,
): { reportsTurnEnd: boolean; reportsSteps: boolean } {
  const agent = (catalog.agents as readonly CatalogAgent[]).find((entry) => entry.id === id);
  if (agent?.hooks === "all" || agent?.programStatus) return { reportsTurnEnd: true, reportsSteps: true };
  if (agent?.hooks === "tools") return { reportsTurnEnd: false, reportsSteps: true };
  return { reportsTurnEnd: false, reportsSteps: false };
}

const START_ERRORS = (catalog.agents as readonly CatalogAgent[]).flatMap((agent) =>
  (agent.startErrors ?? []).map((text) => ({ agent: agent.id, text })),
);
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * The agent whose start error (agents.json `startErrors`) this PTY output holds, or null. The caller
 * must check it is the pane's own agent: a Claude pane showing Cursor's error text is not stuck.
 */
export function agentStartError(output: string): string | null {
  const text = output.replace(ANSI_RE, "");
  return START_ERRORS.find((entry) => text.includes(entry.text))?.agent ?? null;
}

/** Agents whose CLI takes `--append-system-prompt` (verified against `claude --help`, 2026-09-22). */
// pi 1.6.0 takes it too (`pi --help`, 2026-11-24): without it a Pi pane never learned its name.
const APPENDS_SYSTEM_PROMPT = new Set(["claude", "pi"]);

/** The interactive agents, from `src/agents.json` — the one list Rust reads too. */
function catalogSpecs(): Record<string, AgentSpec> {
  return Object.fromEntries((catalog.agents as readonly CatalogAgent[]).map((agent) => [agent.id, {
    id: agent.id as ProviderId,
    displayName: agent.name,
    description: agent.description,
    command: [...agent.command],
    isHeadless: false,
    logo: agent.logo,
    ...(agent.tint ? { tint: agent.tint } : {}),
    ...(agent.fullColourLogo ? { fullColourLogo: true } : {}),
    ...(APPENDS_SYSTEM_PROMPT.has(agent.id) ? { supportsAppendSystemPrompt: true } : {}),
  } satisfies AgentSpec]));
}

export class UnknownProviderError extends Error {
  constructor(public readonly providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = "UnknownProviderError";
  }
}

// The cast: the 11 interactive ids come from agents.json at runtime; the registry test checks
// every one of them (and every CLI cli_detect.rs knows) resolves here.
const SPECS = Object.freeze({
  "claude-headless": {
    id: "claude-headless",
    displayName: "Claude (Planner)",
    description:
      "Headless Claude CLI used as Bridge reasoning engine. Streams JSON events. " +
      "Runs in YOLO mode (--dangerously-skip-permissions) per project policy.",
    // NOTE: --dangerously-skip-permissions is intentional. User wants the Bridge
    // agent to run fully autonomously without per-tool approval prompts. See
    // memory/feedback_agent_autonomy.md for the rationale.
    command: [
      "claude",
      "--dangerously-skip-permissions",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ],
    isHeadless: true,
    logo: LOGO.claude,
    tint: "var(--ai-claude-primary)",
    supportsAppendSystemPrompt: true,
  },
  "ccs-hss-headless": {
    id: "ccs-hss-headless",
    displayName: "CCS HSS (Planner)",
    description:
      "Claude-compatible planner profile launched through `ccs hss`. " +
      "The profile must support Claude CLI stream-json flags.",
    command: [
      "ccs",
      "hss",
      "--dangerously-skip-permissions",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ],
    isHeadless: true,
    logo: LOGO.claude,
    tint: "var(--ai-claude-primary)",
    supportsAppendSystemPrompt: true,
  },
  "codex-headless": {
    id: "codex-headless",
    displayName: "Codex (Planner)",
    description:
      "Headless Codex CLI used as a Bridge reasoning engine. Streams JSONL events via `codex exec --json`.",
    command: [
      "codex",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
    ],
    isHeadless: true,
    logo: LOGO.openai,
  },
  "ccs-hss": {
    id: "ccs-hss",
    displayName: "CCS HSS",
    description: "Custom Claude-compatible shell profile. Interactive.",
    command: ["ccs", "hss"],
    isHeadless: false,
    logo: LOGO.claude,
    tint: "var(--ai-claude-primary)",
    // `ccs` is `claude` under a second account, so it accepts every claude-family flag.
    supportsAppendSystemPrompt: true,
  },
  ...catalogSpecs(),
}) as Readonly<Record<ProviderId, AgentSpec>>;

/** The agents the New workspace offers, in chip order. Each must be an executor spec above. */
export const PICKER_AGENT_IDS = catalog.agents.map((agent) => agent.id as ProviderId);

/** A CLI's spec by id, or undefined for one the registry does not know (custom commands, `shell`). */
export function findSpec(id: string): AgentSpec | undefined {
  return isKnownProvider(id) ? SPECS[id] : undefined;
}

export function resolve(providerId: ProviderId): AgentSpec {
  const spec = SPECS[providerId];
  if (!spec) throw new UnknownProviderError(providerId);
  return spec;
}

export function listProviders(): readonly AgentSpec[] {
  return Object.values(SPECS);
}

export function listExecutors(): readonly AgentSpec[] {
  return listProviders().filter((s) => !s.isHeadless);
}

export function listPlanners(): readonly AgentSpec[] {
  return listProviders().filter((s) => s.isHeadless);
}

export function isKnownProvider(id: string): id is ProviderId {
  return id in SPECS;
}

export type AgentRole = {
  id: string;
  label: string;
  description: string;
  systemPromptAddon: string;
  defaultProvider?: ProviderId;
};

export const BUILTIN_ROLES: readonly AgentRole[] = Object.freeze([
  {
    id: "orchestrator",
    label: "Orchestrator",
    description: "Lead agent that fans work out to a fleet of workers via the lotus_* tools.",
    systemPromptAddon: `
You are the Orchestrator (lead). Coordinate a fleet of worker agents using the
lotus_* tools — do not do the implementation yourself. Run this loop:
  1. lotus_list_fleet — see which workers already exist before spawning more.
  2. Break the request into independent units of work.
  3. For each unit, lotus_spawn_cell with an "initialPrompt" so the worker boots
     already working (one call, not spawn + wait + dispatch). Pick the runner per task.
  4. For follow-ups to a live worker, lotus_dispatch_to_cell with a structured
     task/goal/doneWhen envelope (not raw text).
  5. lotus_gather_results over the worker pane ids to collect every result in one call
     instead of polling per pane.
  6. Synthesize the workers' outputs into one report for the user. Spawn workers in
     parallel when their tasks are independent; serialize only on real dependencies.
Keep yourself out of the diff — your job is delegation, aggregation, and reporting.
`.trim(),
  },
  {
    id: "planner",
    label: "Planner",
    description: "Breaks intent into a 3-7 step numbered plan with file targets. No edits.",
    systemPromptAddon: `
You are acting as a Planner. Output ONLY a numbered plan (3-7 steps) with
concrete file targets. No code edits. No bash. Each step ≤ 25 words. End
with the line "Ready to delegate." so the orchestrator knows you are done.
`.trim(),
  },
  {
    id: "implementer",
    label: "Implementer",
    description: "Edits code to satisfy the explicit done-when. Runs tests. Reports diff.",
    systemPromptAddon: `
You are acting as an Implementer. Read the <task> envelope. Edit only the
files needed to satisfy <done-when>. Run the test suite if one is implied.
Report a unified diff and a PASS/FAIL summary. Do not refactor unrelated
code. Do not exceed scope.
`.trim(),
    defaultProvider: "claude",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description: "Audits diff or code. Tags severity. Never edits files.",
    systemPromptAddon: `
You are acting as a Reviewer. NEVER edit files. Read the <task> envelope,
scan the target diff or code, and output a markdown list of findings:
  - [SEVERITY] file:line — issue (one line)
Severities: BLOCKER, MAJOR, MINOR, NIT. Cap 15 findings. End with the
verdict line: APPROVE | REQUEST_CHANGES | BLOCK.
`.trim(),
  },
  {
    id: "tester",
    label: "Tester",
    description: "Writes tests for the target. Never edits production code.",
    systemPromptAddon: `
You are acting as a Tester. NEVER edit production code — only test files.
Read the <task> envelope, write or extend tests matching the project's
existing test patterns. Run the suite. Report new test names plus a
pass/fail count summary.
`.trim(),
  },
  {
    id: "refactor",
    label: "Refactor",
    description: "Refactors for clarity without changing behavior. Tests must stay green.",
    systemPromptAddon: `
You are acting as a Refactor agent. Behavior MUST NOT change. Run the
test suite before and after. If any test outcome changes, REVERT and
report. Output the diff plus a "behavior preserved: yes/no" line.
`.trim(),
  },
]);

export function getRoleById(id: string | undefined): AgentRole | undefined {
  if (!id) return undefined;
  return BUILTIN_ROLES.find((r) => r.id === id);
}

export function listRoles(): readonly AgentRole[] {
  return BUILTIN_ROLES;
}
