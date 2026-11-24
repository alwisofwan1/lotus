/** POSIX single-quote escaping: wrap in '…', closing each embedded quote with '\''. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Builds the command typed into a Canvas Terminal Node to launch an agent on a
 * task. The prompt is passed as a single positional arg (quoted), so newlines and
 * shell metacharacters stay literal. Trailing \r submits it to the PTY.
 */
export function terminalRunCommand(prompt: string, opts: { skipPermissions?: boolean } = {}): string {
  const flag = opts.skipPermissions ? " --dangerously-skip-permissions" : "";
  return `claude${flag} ${shellQuote(prompt)}\r`;
}
