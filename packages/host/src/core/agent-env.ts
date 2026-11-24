/**
 * The environment an agent this host spawns should see — with the launching session's own
 * markers taken out.
 *
 * **Found by running it (2026-09-07).** A Lotus host started from inside a Claude Code session
 * inherits that session's markers and hands them to every agent it spawns. The first symptom
 * was a terminal cell that reported nothing: the agent printed
 * *"Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"*, so no transcript
 * was written, so no hook fired, so Chat stayed empty and `turn` stayed absent. Read from a
 * phone that is indistinguishable from a broken install.
 *
 * The worse one is quieter: `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` address the **launching
 * session's** channel. An agent that inherits them holds another session's credential. Nothing
 * was observed using it, and that is not a reason to pass it on.
 *
 * **A deny-list, not the `CLAUDE_CODE_` prefix**, and that is load-bearing:
 * `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is a flag Lotus *sets on purpose*
 * (`launch.rs:239`) — it is the feature this app is a front end for. Sweeping the prefix
 * would turn Lotus off. Every entry below is here because it names or reaches the parent
 * session, never because of how it is spelled.
 */
const PARENT_SESSION_MARKERS: readonly string[] = [
  /** Makes the child believe it is nested, which turns its transcript off. */
  "CLAUDE_CODE_CHILD_SESSION",
  /** Another session's id. A cell correlated by it would be filed under someone else's work. */
  "CLAUDE_CODE_SESSION_ID",
  /** How the *launching* process was started, which says nothing true about this cell. */
  "CLAUDE_CODE_ENTRYPOINT",
  /** The launching CLI's own path. */
  "CLAUDE_CODE_EXECPATH",
  /** The launching session's message channel, and the credential for it. */
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];

/**
 * `env` without the parent's session markers, plus whatever `extra` names.
 *
 * Remove the parent's profile by default. A desktop or headless cell that explicitly selects a
 * profile passes it through `extra`, after this cleanup; an ordinary Claude cell therefore uses
 * the standard login even when Lotus itself was launched from `ccs initech`.
 */
export function agentSpawnEnv(
  env: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = { ...env };
  for (const marker of PARENT_SESSION_MARKERS) delete clean[marker];
  delete clean["CLAUDE_CONFIG_DIR"];
  return { ...clean, ...extra };
}

/** The markers stripped, for a test or a diagnostic that wants to name them. */
export function parentSessionMarkers(): readonly string[] {
  return PARENT_SESSION_MARKERS;
}
