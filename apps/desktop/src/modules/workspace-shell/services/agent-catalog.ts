import { detectInstalledClis, type AccountView, type DetectedCli } from "@/lib/tauri-api";

/**
 * What this machine can launch, asked of the machine.
 *
 * The same list was being written out by hand in three places — the canvas palette's launch rows,
 * `CODECHAT_AGENTS`, and whatever string someone typed into a terminal cell's `agentCommand` — so a
 * flag that changed had to be fixed in three, or forgotten in two. There is already one source of
 * truth and it is not a list in TypeScript: `detect_installed_clis` (Rust, `cli_detect.rs`) probes
 * the real `$PATH` and returns each CLI's id, display name, base command **including its autonomy
 * flags**, and whether it actually resolved.
 *
 * So this module holds no catalog of its own. It asks, orders the answer for a menu, and says what
 * is missing. Adding a CLI is a Rust change, in the one file whose tests already check that nothing
 * invents a flag it has not verified.
 */

export interface ShellAgent {
  id: string;
  name: string;
  /** The command a terminal pane runs — binary plus the flags that CLI was verified to accept. */
  command: string;
  installed: boolean;
  /** Where it resolved, when it did. Shown so "installed" is checkable rather than a claim. */
  path: string | null;
  /** Lotus Claude account the pane runs on (issues/07); absent = the globally chosen one. */
  claudeAccount?: string;
}

/**
 * Installed first, then the rest in the order Rust listed them.
 *
 * Both halves are kept: a CLI that is not installed is not a row to hide, it is a row to show
 * greyed out, because "Lotus cannot see codex" and "Lotus does not know about codex" are different
 * problems and only one of them is the user's to fix.
 *
 * The sort is stable — the catalog is re-read on every open, and a comparator that reshuffled
 * equals would move rows under the cursor between one keystroke and the next.
 */
export function orderShellAgents(clis: readonly DetectedCli[]): ShellAgent[] {
  return [...clis]
    .map((cli) => ({ id: cli.id, name: cli.name, command: cli.command, installed: cli.installed, path: cli.path }))
    .sort((left, right) => Number(right.installed) - Number(left.installed));
}

/**
 * Outside Tauri, and on a binary too old to know the command, this is empty rather than a guess.
 *
 * `detectInstalledClis` already degrades to `[]` in both cases; the point of restating it here is
 * that an empty catalog is a legitimate state the callers must draw — "no agent CLI found on this
 * machine" — and not an error to retry.
 */
export async function loadShellAgents(
  detect: () => Promise<DetectedCli[]> = detectInstalledClis,
): Promise<ShellAgent[]> {
  return orderShellAgents(await detect());
}

/** What a launch row promises: this exact command, in the workspace's folder. */
export function agentLaunchCommand(agent: ShellAgent): string {
  return agent.command;
}

/**
 * One extra Claude row per signed-in non-default account, right after the plain Claude row
 * (issues/07: one `claude` runner plus an account, never a runner per account).
 */
export function withClaudeAccounts(agents: readonly ShellAgent[], accounts: readonly AccountView[]): ShellAgent[] {
  const ids = accounts.filter((a) => a.id !== "default" && a.identity && !a.hidden).map((a) => a.id);
  return agents.flatMap((agent) =>
    agent.id === "claude" && agent.installed
      ? [agent, ...ids.map((id) => ({ ...agent, id: `claude@${id}`, name: `${agent.name} · ${id}`, claudeAccount: id }))]
      : [agent],
  );
}

/**
 * A pane's Claude command, pointed at one conversation: an earlier `--resume`/`--continue` goes, so
 * moving a pane twice never stacks them. `null` = no known conversation, a fresh start.
 */
export function claudeResumeCommand(command: string, sessionId: string | null): string {
  const bare = command.replace(/\s+(?:(?:--resume|-r)(?:(?:\s+|=)(?!-)\S+)?|--continue|-c)(?=\s|$)/g, "").trim();
  return sessionId ? `${bare} --resume ${sessionId}` : bare;
}

/** Claude names a transcript after its session: `…/projects/<cwd>/<id>.jsonl`. */
export function claudeSessionIdFromTranscript(path: string | null | undefined): string | null {
  return path?.match(/([^/\\]+)\.jsonl$/)?.[1] ?? null;
}

/** ⇥ on the one Claude row in ⌘K: the default (null), then each account, then the default again. */
export function cycleAccount(accounts: readonly string[], current: string | null): string | null {
  const all = [null, ...accounts];
  return all[(all.indexOf(current) + 1) % all.length] ?? null;
}
