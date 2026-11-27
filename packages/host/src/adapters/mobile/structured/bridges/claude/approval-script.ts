/**
 * Launch details for the approval MCP server (protocol in `approval-server.ts`, issue 26). The
 * answer is `{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`; the CLI honours
 * a rewritten `updatedInput` and `updatedPermissions`, and waits indefinitely.
 */
export const APPROVAL_TOOL_NAME = "approve";
export const APPROVAL_SERVER_NAME = "lotus";
/** What `--permission-prompt-tool` is given: MCP names a tool `mcp__<server>__<tool>`. */
export const APPROVAL_PROMPT_TOOL = `mcp__${APPROVAL_SERVER_NAME}__${APPROVAL_TOOL_NAME}`;

/**
 * The flag that turns this host into the approval MCP server. Not a script path: a compiled
 * binary ignores it and starts a second Lotus host (issue 26).
 */
export const APPROVAL_SERVER_FLAG = "--approval-server";

/** Anything a runtime would accept as "the script to run". */
const SCRIPT = /\.(mjs|cjs|js)$/;

/**
 * Restarts this host as the approval server: compiled binary (`execPath` + flag) or bundled
 * script (`node`, script, flag), told apart by `argv[1]` only so the host's own flags never
 * reach the MCP server. Pure, testable without a binary.
 */
export function selfInvocation(
  execPath: string,
  argv: readonly string[],
): { command: string; args: string[] } {
  const entry = argv[1];
  return {
    command: execPath,
    args: entry !== undefined && SCRIPT.test(entry)
      ? [entry, APPROVAL_SERVER_FLAG]
      : [APPROVAL_SERVER_FLAG],
  };
}

/** The `--mcp-config` value that points `claude` at the generated server. */
export function approvalMcpConfig(socketPath: string, execPath: string, argv: readonly string[]): string {
  const self = selfInvocation(execPath, argv);
  return JSON.stringify({
    mcpServers: {
      [APPROVAL_SERVER_NAME]: {
        command: self.command,
        args: self.args,
        // The socket still travels by env: nothing to leak on a command line, and it is what
        // the child dials back on.
        env: { LOTUS_APPROVAL_SOCKET: socketPath },
      },
    },
  });
}
