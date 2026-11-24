import type { ClaudeSettings } from "@/modules/settings/types";

/**
 * A worker profile: who to spawn for a task, and what to tell them beyond the task itself.
 *
 * Deliberately narrow, and narrower than bb's. bb's preset carries provider, model, reasoning
 * level, service tier, permission mode and environment kind, because bb spawns through its own
 * provider bridge and can set all of them. Lotus spawns a COMMAND into a PTY — so what it can
 * honestly promise is the command, its flags, and instructions. A field the spawner cannot use is
 * a setting that lies.
 */
export type DelegationPreset = {
  id: string;
  name: string;
  /** A key of `DIRECT_AGENT_COMMANDS` — `claude`, `codex`, `gemini`, … */
  agent: string;
  /** Appended to the command, e.g. `--model opus --dangerously-skip-permissions`. */
  args: string;
  /** Appended to the task prompt. Reusable standing orders for this kind of worker. */
  instructions: string;
  /** Claude presets only: the Lotus account the worker runs on (issues/07); absent = the chosen one. */
  account?: string;
};

export type PresetRefusal = "empty-name" | "no-agent" | "duplicate-name";

/**
 * The presets somebody defined, and nothing else the file happens to carry.
 *
 * An entry without an id, a name or an agent is DROPPED rather than repaired: a preset that
 * cannot spawn anything is a button that fails the moment it is pressed, and guessing a default
 * agent for it would spend real money on a choice nobody made.
 */
export function resolveDelegationPresets(
  settings: ClaudeSettings | null | undefined,
): DelegationPreset[] {
  const raw = (settings as { delegation?: unknown } | null | undefined)?.delegation;
  if (!raw || typeof raw !== "object") return [];

  const list = (raw as { presets?: unknown }).presets;
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = text(record.id);
    const name = text(record.name);
    const agent = text(record.agent);
    if (!id || !name || !agent) return [];
    const account = text(record.account);
    return [{ id, name, agent, args: text(record.args), instructions: text(record.instructions), ...(account ? { account } : {}) }];
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * What somebody typed, turned into a preset — or why not.
 *
 * Names must be unique because a preset is chosen from a menu BY its name: two rows reading the
 * same thing are two rows nobody can tell apart, and picking the wrong one costs a real process.
 */
export function prepareDelegationPreset(
  draft: Omit<DelegationPreset, "id">,
  existing: readonly DelegationPreset[],
  /** Set when EDITING: the preset keeps this id, and its own current name is not a clash. */
  replacingId?: string,
): { ok: true; preset: DelegationPreset } | { ok: false; reason: PresetRefusal } {
  const name = draft.name.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, reason: "empty-name" };

  const agent = draft.agent.trim();
  if (!agent) return { ok: false, reason: "no-agent" };

  if (
    existing.some(
      (preset) => preset.id !== replacingId && preset.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    return { ok: false, reason: "duplicate-name" };
  }

  return {
    ok: true,
    preset: {
      id: replacingId ?? `preset_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name,
      agent,
      args: draft.args.trim(),
      instructions: draft.instructions.trim(),
      ...(agent === "claude" && draft.account?.trim() ? { account: draft.account.trim() } : {}),
    },
  };
}

export function presetRefusalMessage(reason: PresetRefusal): string {
  if (reason === "empty-name") return "A preset needs a name.";
  if (reason === "no-agent") return "Pick which agent this preset runs.";
  return "That name is already taken.";
}

/**
 * Can this preset be handed a session id we choose?
 *
 * Only `claude` today, because only `claude` takes `--session-id <uuid>`. Codex and the others
 * have their own resume mechanics or none, and offering a Resume button that cannot be honoured
 * is worse than offering none — so the answer is narrow and said out loud rather than guessed.
 */
/**
 * Commands that end up running Claude, and so accept Claude's own flags.
 *
 * `ccs` is a profile switcher whose documented shape is `ccs <profile> [claude-args...]` — it
 * forwards everything after the profile, so `--session-id` and `--resume` reach Claude intact.
 * It needs that profile, though: `ccs` alone is the CLI's own help, and a session flag there is a
 * usage error rather than a delegation.
 */
const CLAUDE_SHAPED = new Set(["claude", "ccs"]);

export function supportsChosenSession(preset: DelegationPreset): boolean {
  /*
    Read as the command line it becomes, not field by field: people write the ccs profile in either
    place — `agent: "ccs", args: "acme …"` or `agent: "ccs acme"` — and both run the same
    Claude. The program is the first word; for `ccs`, the profile is the next one, and a flag there
    (`ccs --help`) is not a profile.
  */
  const [program, next] = `${preset.agent} ${preset.args}`.trim().split(/\s+/);
  if (!CLAUDE_SHAPED.has(program)) return false;
  // A wrapper is only Claude-shaped once it has been told which Claude to be.
  return program === "claude" || Boolean(next && !next.startsWith("-"));
}

function command(preset: DelegationPreset, flag: string, sessionId: string): string {
  const base = [preset.agent.trim(), preset.args.trim()].filter(Boolean).join(" ");
  // An agent that cannot take an id gets its plain command: appending a flag it does not know
  // would turn a delegation into a usage error.
  return supportsChosenSession(preset) ? `${base} ${flag} ${sessionId}` : base;
}

/** The command that starts a NEW session under an id we picked. */
export function startCommand(preset: DelegationPreset, sessionId: string): string {
  return command(preset, "--session-id", sessionId);
}

/** The command that walks back into that same session. */
export function resumeCommand(preset: DelegationPreset, sessionId: string): string {
  return command(preset, "--resume", sessionId);
}

/**
 * Claude's `--disallowedTools`, each rule its own single-quoted argument — the CLI takes them
 * space-separated, and a rule like `mcp__*__notion-update-page` must reach it with its `*` intact
 * rather than expanded by the shell the pane runs. Only rule characters are accepted — a space too,
 * for `Bash(gh issue close:*)` — so nothing here can close the quote.
 */
export function denyToolsArgs(rules: readonly string[]): string {
  if (rules.length === 0) return "";
  for (const rule of rules) {
    if (!/^[\w*().: -]+$/.test(rule)) throw new Error(`not a tool rule: ${rule}`);
  }
  return `--disallowedTools ${rules.map((rule) => `'${rule}'`).join(" ")}`;
}

/** `command` with tools denied, when there are any to deny. Only for Claude-shaped presets. */
export function withDeniedTools(command: string, rules: readonly string[]): string {
  return rules.length === 0 ? command : `${command} ${denyToolsArgs(rules)}`;
}
