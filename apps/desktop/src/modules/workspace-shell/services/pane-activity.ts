import type { AgentTurnFact } from "@/modules/codecanvas/services/agent-turn-registry";
import { resolveAgentStatus } from "@/modules/codecanvas/services/agent-status-resolve";
import {
  runnerTurnCapability,
  type RunnerTurnCapability,
} from "@/modules/codecanvas/services/runner-capability";
import { detectFleetProvider, type FleetProvider } from "@/modules/codespace/services/bridge/fleet-naming";
import { agentTurnReports } from "@/modules/codespace/services/bridge/agent-registry";
import type { TerminalActivity } from "@/modules/codespace/services/terminal-activity-registry";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import type { AgentRunnerType } from "@/lib/agent-runtime/agent-runner";
import type { GridCell } from "@/modules/codespace/components/types";
import type { PaneActivity, PaneActivityTone, PaneKind } from "@/modules/workspace-shell/types";

/**
 * What a pane is doing right now, for the one indicator the shell draws.
 *
 * **This file decides nothing new.** Lotus already answers this question twice, in two places
 * that took a long time to get right, and both are reused verbatim:
 *
 *  - `terminal-activity-registry` (ADR-0004) — is the PTY doing anything? Three tiers: OSC 133
 *    command boundaries, the agent's own "Working(…)" / ready-footer lines, and a debounced
 *    keystroke window. It is fed by the terminal-v2 runtime the shell already mounts, so the
 *    signal is live here with no new plumbing.
 *  - `agent-status-resolve` (`plans/honest-agent-status/`) — when a hook FACT exists, it outranks
 *    any PTY inference, gated by what that runner can actually report.
 *
 * What is new is only the join: the activity registry supplies the `inferred` half the resolver
 * expects, the hook fact supplies the other, and the result is mapped onto the small vocabulary a
 * pane header and a rail row can draw.
 *
 * Two invariants are inherited and must not be softened here:
 *
 *  1. **`needs-you` is never inferred.** It exists only when a hook said so, for a runner that can
 *     say so. A guessed "answer me" sends someone to a pane that wants nothing.
 *  2. **`needs-you` never animates.** A spinner over "answer me" reads as progress, which is the
 *     exact lie the honest-status work removed. The rule lives in {@link paneActivityAnimates}.
 */


export interface TerminalPaneSignals {
  /** The PTY's lifecycle, as the session registry reports it. */
  runtimeStatus: TerminalRuntimeStatus | undefined;
  /** ADR-0004 terminal activity for this pane. */
  activity: TerminalActivity;
  /** When the pane entered `activity` (`getTerminalActivitySince`); undefined if unknown. */
  activitySinceMs?: number;
  /** The pane's latest hook fact, if one has ever landed. */
  fact: AgentTurnFact | undefined;
  /** When a human last acted on this pane — suppresses an ask raised before it. */
  answeredAtMs: number | undefined;
  /** What this pane's runner can be believed about. */
  capability: RunnerTurnCapability;
  /**
   * Is an agent running in this pane? `false` for a plain shell. The rail only ever says
   * "working" about an agent; a shell running `ls` or the user typing is not agent work.
   * Omitted means `true`.
   */
  agent?: boolean;
  /** The agent printed a known start error (agents.json `startErrors`) and nobody has typed since. */
  startError?: boolean;
  now: number;
}

/**
 * The runner behind a pane's command, in the vocabulary `runnerTurnCapability` speaks.
 *
 * The shell knows a pane by its `agentCommand`, and `detectFleetProvider` already turns that into
 * a provider id — the same function the fleet and the rail use, so a pane cannot be one runner
 * here and another there. This is the last step of that translation and nothing more.
 *
 * A provider with no entry resolves to `undefined`, which `runnerTurnCapability` reads as "cannot
 * be said to report anything" — the pane then falls back to PTY inference alone. That is the
 * deliberate, conservative end of the table: an unstated capability must never license trusting a
 * fact.
 */
export function runnerForProvider(provider: FleetProvider): {
  runner: AgentRunnerType | undefined;
  claudeFamily: boolean;
} {
  switch (provider) {
    case "claude":
    case "claude-headless":
      return { runner: "claude", claudeFamily: false };
    // A second Claude account behind the `ccs` wrapper drives the same global hooks.
    case "ccs-hss":
    case "ccs-hss-headless":
      return { runner: "custom", claudeFamily: true };
    case "codex":
    case "codex-headless":
      return { runner: "codex", claudeFamily: false };
    case "cursor":
      return { runner: "cursor", claudeFamily: false };
    default:
      return { runner: undefined, claudeFamily: false };
  }
}

/**
 * Binaries the provider registry does not recognise, and the evidence for each.
 *
 * Two catalogs disagree, and both are right about their own job. `detect_installed_clis` (Rust) is
 * what the shell actually launches, and it runs cursor as **`cursor-agent --yolo`**; the TS agent
 * registry's cursor spec was `["cursor"]`, so `detectFleetProvider("cursor-agent …")` answered
 * `"shell"` — verified 2026-09-21, along with `ccs` giving the same answer. The spec is
 * `["cursor-agent"]` since 2026-11-16; the entry stays for a path (`/opt/homebrew/bin/cursor-agent`).
 *
 * This table is consulted ONLY after the registry has declined, and only for the capability
 * question. It must never be used to name or label a pane: the registry stays the one source for
 * that, and a second naming table is how two surfaces come to call one agent different things.
 */
const CAPABILITY_BY_BINARY: Record<string, { runner: AgentRunnerType; claudeFamily: boolean }> = {
  "cursor-agent": { runner: "cursor", claudeFamily: false },
  // `ccs` / `csp` wrap a second Claude account and drive the same global hooks, so they report
  // everything the Claude family reports.
  ccs: { runner: "custom", claudeFamily: true },
  csp: { runner: "custom", claudeFamily: true },
};

/** The first word of a command, which is the binary being run. */
function commandBinary(agentCommand: string | undefined): string {
  const head = agentCommand?.trim().split(/\s+/)[0] ?? "";
  // A path, not a bare name: `/opt/homebrew/bin/cursor-agent` is still cursor-agent.
  return head.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

/**
 * What the pane's runner implies about which turn facts may be believed.
 *
 * `detectedProvider` is the runner the pane is ACTUALLY running, as `fleet-output-tap` read it
 * from the CLI's own banner and `useFleetIdentitySync` stored on the cell. It has to be consulted,
 * and it has to win, because the launch command is only where a pane started:
 *
 * Observed live 2026-09-22. Pane `3e4a0cde` was opened as a plain shell — `agent_command` is the
 * empty string in `codespace.sqlite3` — and the operator then typed `claude` into it by hand. The
 * fleet list named it `claude-2` correctly, from the detected provider; this function saw only the
 * empty command, answered "shell", and `runnerTurnCapability(undefined)` then refused EVERY hook
 * fact the pane produced. Rust held a fresh `running` fact for it the whole time and the badge
 * still read "ready", permanently, because nothing else could ever correct it.
 *
 * Same precedence as `deriveFleetIdentity`: runtime reality over birth intent, and the launch
 * command only when nothing was detected.
 */
export function capabilityForCommand(
  agentCommand: string | undefined,
  detectedProvider?: FleetProvider | null,
): RunnerTurnCapability {
  const fromCommand = detectFleetProvider(agentCommand);
  const provider =
    detectedProvider && detectedProvider !== "shell" ? detectedProvider : fromCommand;
  // grok, pi, agy: not a runner type, but agents.json says what they report.
  const fromCatalog = agentTurnReports(provider);
  if (fromCatalog.reportsSteps) return fromCatalog;
  const fromProvider = runnerForProvider(provider);
  if (fromProvider.runner) {
    return runnerTurnCapability(fromProvider.runner, fromProvider.claudeFamily);
  }

  const known = CAPABILITY_BY_BINARY[commandBinary(agentCommand)];
  return known
    ? runnerTurnCapability(known.runner, known.claudeFamily)
    : // Nothing established about this runner. `runnerTurnCapability(undefined)` reads that as
      // "believe nothing", which lands the pane on PTY inference alone — the conservative end.
      runnerTurnCapability(undefined);
}

/**
 * A terminal pane's state.
 *
 * Lifecycle first, because a dead pane is dead whatever the last hook said — the same order
 * `resolveAgentStatus` uses internally, for the same reason.
 */
export function resolveTerminalPaneActivity(signals: TerminalPaneSignals): PaneActivity {
  const { runtimeStatus } = signals;

  if (runtimeStatus === "failed") return "failed";
  if (runtimeStatus === "exited") return "done";
  if (runtimeStatus === "starting") return "starting";
  // `idle` here is the registry's word for "no session has ever been made for this pane", and
  // `undefined` is a pane restored from a snapshot whose PTY has not been reconnected. Neither is
  // a resting agent: there is nothing running to rest.
  if (runtimeStatus === undefined || runtimeStatus === "idle") return "offline";
  // Alive but stuck: the CLI said it cannot start a session (Cursor's "Model unavailable"). The
  // process sits at its prompt, which would otherwise read as a ready agent.
  if (signals.startError) return "failed";
  if (signals.agent === false) return "idle";

  /*
    Alive. The PTY-derived guess is the activity registry's answer, which is a far better input
    than the canvas's launch tone: that one maps a pane settled at its prompt to `running` on
    purpose (the false-"working" state the resolver exists to correct), while this one is built to
    tell work from repaint. `atPrompt` carries the distinction the status alone cannot.
  */
  const inferred = signals.activity === "running" ? "running" : "idle";

  const status = resolveAgentStatus({
    inferred,
    fact: signals.fact,
    reportsTurnEnd: signals.capability.reportsTurnEnd,
    reportsSteps: signals.capability.reportsSteps,
    answeredAtMs: signals.answeredAtMs,
    atPrompt: signals.activity === "idle",
    ptyIdleSinceMs: signals.activity === "idle" ? signals.activitySinceMs : undefined,
    now: signals.now,
  });

  switch (status) {
    case "running":
      return "working";
    case "needs-you":
      return "needs-you";
    case "completed":
      return "done";
    case "error":
      return "failed";
    case "idle":
      return "idle";
    default:
      // `connecting` and `stalled` cannot be produced from the inputs above (the resolver only
      // ever returns one of the five handled cases, or `inferred`, which is `running`/`idle`
      // here). Declining an unknown one rather than guessing keeps a future status from being
      // silently drawn as something it is not.
      return "idle";
  }
}

export interface ChatPaneSignals {
  /** Is a reply arriving right now? `ChatView` is the only honest source. */
  streaming: boolean;
  /** New Chat (beta, 07d): a turn waits on an approval or a question. */
  waiting?: boolean;
}

/**
 * A thread pane's state.
 *
 * There is no hook fact here and there must not be an inferred one: a conversation blocked on a
 * human is a thing `ChatView` renders itself, inside the pane, and a rail badge that guessed at
 * it would be the first inferred `needs-you` in the app.
 */
export function resolveChatPaneActivity(signals: ChatPaneSignals): PaneActivity {
  if (signals.waiting) return "needs-you";
  return signals.streaming ? "working" : "idle";
}

export interface PaneActivitySignals {
  terminal?: TerminalPaneSignals;
  chat?: ChatPaneSignals;
}

/**
 * One pane, whatever kind it is.
 *
 * Browser, editor and bridge panes are surfaces, not runners: they have nothing to report and are
 * drawn at rest rather than given a state that would have to be invented.
 */
export function resolvePaneActivity(cell: GridCell, signals: PaneActivitySignals): PaneActivity {
  if (cell.type === "chat") {
    return signals.chat ? resolveChatPaneActivity(signals.chat) : "idle";
  }
  if (cell.type === "terminal") {
    return signals.terminal ? resolveTerminalPaneActivity(signals.terminal) : "offline";
  }
  return "idle";
}

const TONE: Record<PaneActivity, PaneActivityTone> = {
  offline: "muted",
  starting: "boot",
  idle: "muted",
  working: "live",
  "needs-you": "ask",
  failed: "warn",
  done: "muted",
};

const LABEL: Record<PaneActivity, string> = {
  offline: "not started",
  starting: "starting",
  idle: "ready",
  working: "working",
  "needs-you": "needs you",
  failed: "failed",
  done: "done",
};

export function paneActivityTone(activity: PaneActivity): PaneActivityTone {
  return TONE[activity];
}

export function paneActivityLabel(activity: PaneActivity): string {
  return LABEL[activity];
}

/**
 * Motion is reserved for work in progress.
 *
 * `needs-you` is deliberately excluded: it must not read as progress. `starting` is excluded too —
 * it lasts a second or two, and a second animation competing with the first would make a booting
 * workspace flicker.
 */
export function paneActivityAnimates(activity: PaneActivity): boolean {
  return activity === "working";
}

/**
 * Which states are worth a number next to them.
 *
 * "bekerja · 4m" and "butuh kamu · 12m" are the two that change what someone does next; "siap ·
 * 12m" is a fact about nothing. The fleet rail's own argument, applied to a smaller surface.
 */
export function paneActivityShowsAge(activity: PaneActivity): boolean {
  return activity === "working" || activity === "needs-you";
}

/**
 * How long a state has held, in the coarsest honest unit.
 *
 * Under a minute there is no number: a badge that counts seconds pulls the eye to a pane that has
 * only just started, which is the opposite of what this indicator is for. `null` means "do not
 * print an age", not "zero".
 */
export function formatPaneActivityAge(ageMs: number): string | null {
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return null;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export interface PaneActivityState {
  activity: PaneActivity;
  /** When this pane ENTERED this state — the stamp an age is measured from. */
  since: number;
}

/**
 * Keep the moment a state was entered, across recomputations.
 *
 * Stamping on every render would restart every age on every keystroke; stamping only on a CHANGE
 * is what makes "butuh kamu · 12m" mean twelve minutes. Pure and idempotent on purpose — given the
 * same previous map and the same activities it returns the same stamps, so it is safe to run
 * inside a `useMemo` that React may invoke twice.
 */
export function stampPaneActivities(
  previous: ReadonlyMap<string, PaneActivityState>,
  activities: ReadonlyMap<string, PaneActivity>,
  now: number,
): Map<string, PaneActivityState> {
  const next = new Map<string, PaneActivityState>();
  for (const [paneId, activity] of activities) {
    const known = previous.get(paneId);
    // Reusing the object, not just the number, keeps the reference stable for a memoised row.
    next.set(paneId, known && known.activity === activity ? known : { activity, since: now });
  }
  return next;
}

/** The kinds that can report anything at all — the rest are surfaces. */
export function paneKindReportsActivity(kind: PaneKind): boolean {
  return kind === "terminal" || kind === "thread";
}

/**
 * What the rail sorts and the chrome counts: the panes that want a human.
 *
 * Oldest first — a pane that has been blocked for twenty minutes is more urgent than one blocked
 * for ten, and answering in arrival order is what keeps a fleet from starving its first ask.
 */
export function needsYouPaneIds(states: ReadonlyMap<string, PaneActivityState>): string[] {
  return [...states.entries()]
    .filter(([, state]) => state.activity === "needs-you")
    .sort((left, right) => left[1].since - right[1].since)
    .map(([paneId]) => paneId);
}

/** How many panes are working right now — the other half of the chrome's count. */
export function workingPaneCount(states: ReadonlyMap<string, PaneActivityState>): number {
  let count = 0;
  for (const state of states.values()) if (state.activity === "working") count += 1;
  return count;
}
