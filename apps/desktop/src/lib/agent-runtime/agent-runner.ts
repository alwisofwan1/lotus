export type AgentRunnerType = "claude" | "ccs" | "csp" | "codex" | "cursor" | "custom";

export type AgentPermissionMode = "full" | "safe" | string;

const CLAUDE_PROFILE: Record<"ccs" | "csp", string> = {
  ccs: "ccs",
  csp: "csp",
};

/**
 * How a session id is applied (ADR-0027 Phase 5, resume-on-reopen). `new` mints the session under
 * a caller-chosen id on first launch (pre-mint); `resume` continues a previously stored session.
 */
export type RunnerSessionMode = "new" | "resume";

/**
 * How a runner is told which conversation to continue (ADR-0027 Phase 5; Session Widget Slice 06).
 *
 * There are two shapes, and conflating them is what kept codex unsupported for months:
 *
 * - **`flag`** — the id rides as an option on the normal invocation (`claude --resume <id>`);
 * - **`subcommand`** — the id changes what is being run (`codex resume [OPTIONS] <id>`), so it goes
 *   right after the binary and the id trails as a positional.
 *
 * Probed against the installed CLIs on 2026-09-06/07, not assumed — every entry below was read out
 * of that runner's own `--help`. `codex resume` accepts the same `--sandbox` /
 * `--ask-for-approval` / `--dangerously-bypass-approvals-and-sandbox` flags the base command does,
 * which is what makes the posture flags safe to keep in the subcommand form.
 *
 * `grok` and `opencode` can both resume too (`grok --resume`, `opencode --session <id>`), and grok
 * can even PRE-MINT with `--session-id`. Neither is listed here because they reach Lotus as
 * `custom` runners, which this table cannot tell apart — they need a descriptor on the Runner
 * Registry entry itself. See `plans/codecanvas-session-widget/issues/06-*.md`.
 */
interface RunnerSessionShape {
  /** Suffix-flag form, keyed by whether the id starts a session or continues one. */
  flag?: Partial<Record<RunnerSessionMode, (id: string) => string>>;
  /** Subcommand form: the words inserted after the binary, with the id trailing as a positional. */
  subcommand?: { resume: string };
}

const SESSION_SHAPE: Partial<Record<AgentRunnerType, RunnerSessionShape>> = {
  claude: { flag: { new: (id) => `--session-id ${id}`, resume: (id) => `--resume ${id}` } },
  ccs: { flag: { new: (id) => `--session-id ${id}`, resume: (id) => `--resume ${id}` } },
  csp: { flag: { new: (id) => `--session-id ${id}`, resume: (id) => `--resume ${id}` } },
  // `codex resume [OPTIONS] [SESSION_ID]` — a subcommand, which is why a flag table could never
  // express it. There is no `new` form: codex mints its own id and Lotus captures it afterwards.
  codex: { subcommand: { resume: "resume" } },
  // `cursor-agent --resume [chatId]`. No pre-mint either.
  cursor: { flag: { resume: (id) => `--resume ${id}` } },
};

/**
 * Apply a custom runner's own session template (Session Widget, Slice 06).
 *
 * Built-in runners are described by {@link SESSION_SHAPE}, which is keyed by runner type. A custom
 * runner has no type of its own — grok, opencode and a second-account Claude all arrive as
 * `custom` — so the method travels with its Runner Registry entry instead, as a template holding
 * `{id}`.
 *
 * Returns an empty string when there is no template or no id, which is what makes the caller's
 * behaviour unchanged for every runner that has not declared one.
 */
export function applyRunnerSessionTemplate(
  template: string | null | undefined,
  sessionId: string | null | undefined,
): string {
  const id = sessionId?.trim();
  const shape = template?.trim();
  if (!id || !shape) return "";
  // A template without the placeholder is a mistake worth failing loudly on rather than silently
  // appending an id nobody asked for.
  if (!shape.includes("{id}")) return "";
  return shape.replaceAll("{id}", id);
}

/**
 * Whether a runner can continue a conversation, taking a custom runner's registry entry into
 * account. `custom` runners answer `false` from {@link runnerSupportsResume} alone, because that
 * table cannot tell one apart from another.
 */
export function runnerCanResume(
  runner: AgentRunnerType,
  registry?: { resume_template?: string | null; claude_family?: boolean } | null,
): boolean {
  if (runnerSupportsResume(runner)) return true;
  if (registry?.claude_family) return true;
  const template = registry?.resume_template?.trim();
  return Boolean(template && template.includes("{id}"));
}

/** True when this runner can continue a stored conversation at all (ADR-0027 Phase 5). */
export function runnerSupportsResume(runner: AgentRunnerType): boolean {
  const shape = SESSION_SHAPE[runner];
  return Boolean(shape?.flag?.resume || shape?.subcommand?.resume);
}

/**
 * True when Lotus can choose the id in advance instead of discovering it after the fact.
 *
 * Only grok can do this today, and it arrives as a `custom` runner — so this is `false` for every
 * built-in. It matters because pre-minting sidesteps the capture race entirely: there is no
 * transcript directory to diff when we already know the id.
 */
export function runnerSupportsPreMintedSession(runner: AgentRunnerType): boolean {
  return Boolean(SESSION_SHAPE[runner]?.flag?.new);
}

/** The runners that are Claude Code under the hood, so they accept `--append-system-prompt`, `--model`,
 * session pinning, the native `/skill` command, and MCP-director coordination. `ccs`/`csp` are just
 * `claude --profile …`. */
const CLAUDE_FAMILY_RUNNERS: ReadonlySet<AgentRunnerType> = new Set<AgentRunnerType>(["claude", "ccs", "csp"]);

/**
 * Single source of truth for "does this runner get Claude-family treatment". A built-in
 * claude/ccs/csp always qualifies. A `custom` runner that is actually Claude under a different account
 * or profile (e.g. a `ccs <profile>` / `claude --profile …` wrapper) opts in via its Runner Registry
 * `claudeFamily` flag — pass that flag as `claudeFamilyOverride`. Undefined runner defaults to claude.
 *
 * Replaces the sets that were duplicated across live-agent-spawn, canvas-intake-effects, and swarm
 * director-eligibility — keep this the only definition.
 */
export function isClaudeFamilyRunner(
  runner: AgentRunnerType | undefined,
  claudeFamilyOverride?: boolean,
): boolean {
  return CLAUDE_FAMILY_RUNNERS.has(runner ?? "claude") || Boolean(claudeFamilyOverride);
}

/**
 * The flags one permission stop becomes, for a runner that runs the `claude` binary.
 *
 * **Absent from this table means the gate is off**, which is what keeps every caller that
 * predates the phone's scale exactly where it was: `full`, `yolo`, `undefined` and anything
 * unrecognised all land on `--dangerously-skip-permissions`, the behaviour
 * {@link resolveRunnerCommand} has had since it was written.
 *
 * `safe` and `manual` are the same posture under two names — the legacy word and the CLI's
 * own — and both are the empty string, because bare `claude` already asks per action. Sending
 * `--permission-mode manual` would be equivalent but not identical, and `deriveGating` reads
 * the command that actually ran; the fewer flags in it, the fewer ways it can disagree.
 */
/**
 * The words that mean *the gate is off*, in every vocabulary that reaches this file: the
 * canvas' own, the phone's legacy one, and each CLI's own stop.
 *
 * Exported because a second place has to ask the same question — `resolveRunnerLaunch` decides
 * whether a node's request outranks the Runner Registry, and it used to ask it as
 * `mode === "safe"`. That was right while there were two words and silently wrong the moment
 * there were six: `manual` is a request to be gated, and it was being read as *not safe*, so
 * the registry's YOLO won and the cell was born bypassing everything.
 */
const UNGATED_MODES: ReadonlySet<string> = new Set([
  "full",
  "yolo",
  "bypassPermissions",
  "full-access",
]);

/** Whether this stop asks for the gate to be off. An unknown stop is **not** one of them. */
export function isUngatedMode(mode: string | undefined): boolean {
  return mode !== undefined && UNGATED_MODES.has(mode);
}

const SKIP_CLAUDE = "--dangerously-skip-permissions";

const CLAUDE_POSTURE: Readonly<Record<string, string>> = {
  safe: "",
  manual: "",
  plan: "--permission-mode plan",
  acceptEdits: "--permission-mode acceptEdits",
  // The three words that mean *the gate is off*: the canvas', the phone's legacy one, and
  // the CLI's own. Spelled out rather than left to a fallback — see {@link resolveRunnerCommand}.
  full: SKIP_CLAUDE,
  yolo: SKIP_CLAUDE,
  bypassPermissions: SKIP_CLAUDE,
};

/**
 * The same for `codex`, whose stops are pairs: it has no `--permission-mode` at all, so each
 * word from the phone expands into a sandbox and an approval policy. `safe` stays bare
 * `codex` — the posture it has meant here since before the scale existed, where the operator's
 * own `~/.codex/config.toml` decides.
 */
const BYPASS_CODEX = "--dangerously-bypass-approvals-and-sandbox";

const CODEX_POSTURE: Readonly<Record<string, string>> = {
  safe: "",
  "read-only": "--sandbox read-only --ask-for-approval on-request",
  auto: "--sandbox workspace-write --ask-for-approval on-request",
  full: BYPASS_CODEX,
  yolo: BYPASS_CODEX,
  "full-access": BYPASS_CODEX,
};

/**
 * Resolve a runner into the shell command that launches its CLI.
 *
 * `permissionMode` is a stop from the runner's advertised scale
 * (`packages/host/src/adapters/mobile/spawn-tuning.ts`), or one of the two words that
 * predate it. "safe" drops the skip-permissions/yolo flag. `extraFlags` is the
 * user's per-runner "extra flags (optional)" from the Runner Registry (ADR-0027),
 * appended verbatim to the resolved command. `sessionId`, when set and supported by the
 * runner, appends the session flag (`--session-id <id>` for a fresh `new` session, or
 * `--resume <id>` to continue) so a reopened live-agent node continues its prior session
 * instead of starting fresh (ADR-0027 Phase 5). `sessionMode` defaults to `resume`.
 *
 * **A stop this build does not recognise resolves to the runner's *gated* command, never its
 * ungated one.** The table is exhaustive over the words that mean the gate is off, so the
 * fallback is the safe direction by construction. It has to be: since 2026-08-27 the set of
 * stops belongs to the host that advertises them, not to this file, so a newer phone can send
 * a word this build has never read — and an agent that asks too often is a nuisance, while one
 * that asks nothing cannot be called back (ADR-8). `undefined` is not such a word: it is the
 * argument's own default of `full`, which every caller before the scale relied on.
 *
 * Order is base → session → extra flags.
 */
export function resolveRunnerCommand(
  runner: AgentRunnerType,
  customCommand?: string,
  permissionMode: AgentPermissionMode = "full",
  extraFlags?: string,
  sessionId?: string,
  sessionMode: RunnerSessionMode = "resume",
): string {
  const id = sessionId?.trim();
  const shape = SESSION_SHAPE[runner];
  // A subcommand runner puts the id LAST, after the options, because that is where its own usage
  // line puts it (`codex resume [OPTIONS] [SESSION_ID]`).
  const subcommand = id && sessionMode === "resume" ? shape?.subcommand?.resume : undefined;
  const sessionPart = id && !subcommand ? shape?.flag?.[sessionMode]?.(id) ?? "" : "";
  const trailingId = subcommand ? id : "";
  const withSuffix = (cmd: string): string =>
    [cmd, sessionPart, extraFlags?.trim(), trailingId].filter(Boolean).join(" ");

  if (runner === "custom") {
    if (!customCommand) throw new Error("custom runner requires a command");
    return withSuffix(customCommand);
  }

  /** A base command plus whatever the posture adds, with no double space when it adds nothing. */
  const posture = (base: string, table: Readonly<Record<string, string>>): string => {
    const flags = table[permissionMode] ?? "";
    return withSuffix(flags === "" ? base : `${base} ${flags}`);
  };

  if (runner === "claude") return posture("claude", CLAUDE_POSTURE);
  if (runner === "ccs" || runner === "csp") {
    return posture(`claude --profile ${CLAUDE_PROFILE[runner]}`, CLAUDE_POSTURE);
  }
  // Cursor advertises no scale, so nothing but the legacy words ever reaches it.
  if (runner === "cursor") {
    return posture("cursor-agent", { safe: "", full: "--yolo", yolo: "--yolo" });
  }
  return posture(subcommand ? `codex ${subcommand}` : "codex", CODEX_POSTURE);
}
