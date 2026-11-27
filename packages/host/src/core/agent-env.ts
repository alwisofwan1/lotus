/** Strip inherited session credentials and markers with an explicit denylist so child agents retain feature flags. */
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

/** Clear the inherited profile so child agents use the standard login unless the caller explicitly selects another profile. */
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
