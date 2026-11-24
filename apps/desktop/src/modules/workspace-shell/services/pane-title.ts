import {
  formatPaneTitle,
  paneTitleSaysNothing,
} from "@/modules/codespace/services/pane-title/pane-title-normalizer";
import { listExecutors } from "@/modules/codespace/services/bridge/agent-registry";
import { deriveFleetIdentity, detectFleetProvider } from "@/modules/codespace/services/bridge/fleet-naming";
import { typedPart } from "@/modules/workspace-shell/services/browser-link";
import type { PaneAgentTitle } from "@/lib/tauri-api";
import type { GridCell, PaneTitleStatus } from "@/modules/codespace/components/types";
import type { PaneActivity } from "@/modules/workspace-shell/types";
import type { TitleSource } from "@/modules/conversation-title/domain";

/**
 * What a pane is called, and when that may change.
 *
 * The rules are `bb`'s, because they are the ones that make a sidebar readable: a pane is named
 * after **what was asked of it**, the name is set from the first prompt so it exists before any
 * model has answered, and once a pane has a name nothing takes it away again. `bb` titles a thread
 * once and never regenerates (`applyGeneratedThreadTitle` refuses when a title is already there);
 * a name that follows the latest turn is a row that rewrites itself while you are reading it.
 *
 * What is NOT here: the model call. This layer only decides the name a prompt deserves and whether
 * a pane is allowed to take it — both pure, both testable without a store or a CLI.
 */

/** `bb`'s threshold: below this, the prompt IS the title and a model has nothing to add. */
const MIN_WORDS_WORTH_REFINING = 5;

/**
 * The title a prompt gives a pane, or null when it gives none.
 *
 * The first non-empty line, not the whole prompt: everything after it is context — pasted logs, a
 * file listing, an error — and a title made from those describes the evidence rather than the task.
 */
export function firstPromptTitle(prompt: string): string | null {
  // Browser picks lead a message as markup; the name is what the person asked.
  const firstLine = typedPart(prompt)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  return formatPaneTitle(firstLine.replace(/\s+/g, " "));
}

/**
 * Whether asking a model for a shorter name is worth a subprocess.
 *
 * `bb` asks the same question with the same number, and the reason is visible in the answer: a
 * three-word prompt summarised into five words comes back as itself.
 */
export function titleIsWorthShortening(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/u).filter(Boolean);
  return words.length >= MIN_WORDS_WORTH_REFINING;
}

export interface PaneTitlePatch {
  /** `null` clears a title that named another conversation. */
  title: string | null;
  status: PaneTitleStatus | null;
  updatedAt: number;
  /** The conversation the title names: its transcript path. `null` forgets it. */
  sessionKey?: string | null;
}

/** CLIs whose launch command is the first thing typed into a fresh shell: every registry agent, plus wrappers and CLIs Lotus does not launch itself. */
const AGENT_LAUNCHERS = new Set([
  ...listExecutors().map((spec) => spec.command[0]),
  "ccs", "cccs", "aider", "amp", "qwen", "crush",
]);

/**
 * Whether `prompt` starts an agent rather than asking one for something. Leading `VAR=value`
 * assignments and a path are skipped; the launcher must be the whole first word, so "claude, fix
 * the test" is a task.
 */
export function isAgentLaunchCommand(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/u).filter(Boolean);
  const command = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (!command) return false;
  return AGENT_LAUNCHERS.has(command.split("/").pop() ?? command);
}

type TitleCell = Pick<GridCell, "type"> & {
  title?: string | null;
  titleStatus?: PaneTitleStatus;
  titleSessionKey?: string | null;
  agentCommand?: string | null;
  runtimeProvider?: Parameters<typeof deriveFleetIdentity>[0]["detectedProvider"];
  cwd?: string | null;
};

export interface PaneTitleSeedInput {
  cell: TitleCell;
  prompt: string;
  now: number;
}

/**
 * The patch a first prompt earns, or null when the pane already has a name.
 *
 * Refusing is most of the job. A pane someone renamed, and a pane already titled by an earlier
 * prompt, both keep what they have — the second is what makes the name stable rather than a
 * running commentary on the last thing typed.
 *
 * `pending` is not a placeholder: it says this name came from the prompt and may still be refined
 * once, which is exactly what the refine pass looks for.
 */
export function paneTitleSeed({ cell, prompt, now }: PaneTitleSeedInput): PaneTitlePatch | null {
  if (cell.type !== "terminal") return null;
  // Only an agent is asked for a task. A shell is typed commands at, and the first of those is
  // usually the one that starts the agent ("Dangerously skip permissions" reached the rail so).
  const identity = deriveFleetIdentity({
    agentCommand: cell.agentCommand ?? undefined,
    detectedProvider: cell.runtimeProvider,
  });
  if (identity.provider === "shell") return null;
  if (isAgentLaunchCommand(prompt)) return null;
  if (cell.title?.trim()) return null;

  const title = firstPromptTitle(prompt);
  if (!title) return null;
  return { title, status: "pending", updatedAt: now };
}

/** What the shared title control says about where a pane's title came from. */
export function paneTitleSource(cell: Pick<TitleCell, "title" | "titleStatus">): TitleSource | undefined {
  if (!cell.title?.trim()) return undefined;
  if (cell.titleStatus === "manual") return "manual";
  return cell.titleStatus === "pending" ? "prompt" : "auto";
}

/**
 * The patch a rename in the title control makes. `""` hands the pane back to the automatic
 * title: cleared with no conversation key, so the next settled turn names it again.
 */
export function paneTitleRename(title: string, now: number): PaneTitlePatch {
  return title
    ? { title, status: "manual", updatedAt: now }
    : { title: null, status: null, updatedAt: now, sessionKey: null };
}

/** The states that mean a turn has stopped — the moment a title is worth revisiting. */
const SETTLED: ReadonlySet<PaneActivity> = new Set<PaneActivity>([
  "idle",
  "needs-you",
  "done",
]);

/** A working pane just stopped. */
export function turnJustSettled(previous: PaneActivity | undefined, activity: PaneActivity): boolean {
  return previous === "working" && SETTLED.has(activity);
}

export interface PaneTitlePlanInput {
  cell: TitleCell;
  /** What the pane's agent transcript says; `null` when no transcript is known for it. */
  agent: PaneAgentTitle | null;
  /** Conversations this window already asked a model to title, successful or not. */
  generatedKeys: ReadonlySet<string>;
  enabled: boolean;
  now: number;
}

export type PaneTitlePlan =
  | { kind: "none" }
  | { kind: "apply"; patch: PaneTitlePatch }
  | { kind: "generate"; sessionKey: string; clearStale: boolean };

/**
 * What to do with a pane's title once a turn has settled.
 *
 * A title names a CONVERSATION, not a pane: `/clear`, `/resume` and a new `claude` in the same
 * shell all start another one, and a name kept from the earlier one is wrong (the screenshot of
 * 2026-10-10: "Pane rendering and activity logs" over a conversation the agent itself had named
 * "Fitur auto title codeshare"). So the stored title carries its conversation's key, and a key
 * that no longer matches makes the title stale.
 *
 * The agent's own title (Claude's `ai-title`, Codex's `thread_name`) is free and wins; a model is
 * asked only when the agent wrote none, once per conversation. A rename is never overruled.
 */
export function planPaneTitle({ cell, agent, generatedKeys, enabled, now }: PaneTitlePlanInput): PaneTitlePlan {
  const none = { kind: "none" } as const;
  if (!enabled || cell.type !== "terminal" || !agent) return none;
  // Typed by a person: kept until they pick "Use automatic title", whatever the conversation.
  if (cell.titleStatus === "manual") return none;

  const key = agent.sessionKey;
  const stored = cell.title?.trim() || undefined;
  const sameConversation = cell.titleSessionKey === key;
  const context = { agentCommand: cell.agentCommand, cwd: cell.cwd };
  // A settled name for THIS conversation stays: a later agent title must not undo a Regenerate.
  if (stored && sameConversation && cell.titleStatus === "ready" && !paneTitleSaysNothing(stored, context)) return none;

  const agentTitle = agent.title?.trim();
  if (agentTitle && !paneTitleSaysNothing(agentTitle, context)) {
    const title = formatPaneTitle(agentTitle);
    if (title) {
      if (title === stored && sameConversation && cell.titleStatus === "ready") return none;
      return { kind: "apply", patch: { title, status: "ready", updatedAt: now, sessionKey: key } };
    }
  }

  if (generatedKeys.has(key)) return none;
  // A key-less `ready` title predates titles knowing their conversation, so it may name anything;
  // a key-less `pending` one is the seed of the prompt just sent, so it names this one.
  const seeded = !cell.titleSessionKey && cell.titleStatus === "pending";
  const stale = Boolean(stored) && !sameConversation && !seeded;

  if (!agent.hasPrompt) {
    return stale
      ? { kind: "apply", patch: { title: null, status: null, updatedAt: now, sessionKey: key } }
      : none;
  }

  const usable = stored && !paneTitleSaysNothing(stored, context) ? stored : undefined;
  if (usable && sameConversation && cell.titleStatus === "ready") return none;
  if (usable && !stale && !titleIsWorthShortening(usable)) {
    return { kind: "apply", patch: { title: usable, status: "ready", updatedAt: now, sessionKey: key } };
  }
  return { kind: "generate", sessionKey: key, clearStale: stale };
}

/**
 * Which CLI family should be asked for the name.
 *
 * The pane's own, so a codex pane costs codex tokens and works for someone who never signed into
 * Claude. Only the families whose one-shot mode this app already drives are named; the rest fall
 * back in Rust rather than being guessed at here.
 */
export function titleProviderForCommand(agentCommand?: string | null): "claude" | "codex" {
  return detectFleetProvider(agentCommand ?? undefined) === "codex" ? "codex" : "claude";
}
