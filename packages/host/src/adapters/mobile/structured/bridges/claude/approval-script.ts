/**
 * The MCP server `claude` calls to ask whether a tool may run — as source, not as a file in
 * the tree.
 *
 * It has to be a **separate process** because `claude` spawns it itself from `--mcp-config`,
 * and it has to reach back into the session that started the cell. So it is written to the
 * session's temp directory at spawn time and connects to a unix socket this host owns
 * (`LOTUS_APPROVAL_SOCKET`). A socket rather than a port and a token: nothing to leak, no
 * listener to reach from another machine, and it works the same on a VPS.
 *
 * **The protocol lives in `approval-server.ts`, as ordinary typed code.** It was a string
 * here until 2026-09-10, written to a temp `.mjs` at spawn time — the reasoning being that a
 * string survives bundling where a copied asset would be forgotten. True, and beside the
 * point: what broke was the *command*, not the file. Nothing runs the file now, so keeping
 * eighty lines of unreachable protocol beside a live copy of it would be the next defect
 * rather than a safeguard (issue 26).
 *
 * Verified against the real CLI on 2026-09-07:
 * - `tools/call` arrives as `{name, arguments: {tool_name, input, tool_use_id}}`.
 * - The answer is JSON **inside** a text content block: `{behavior: "allow", updatedInput}`
 *   or `{behavior: "deny", message}`. Proved 2026-09-08 that a **rewritten** `updatedInput`
 *   is honoured: an `answers` map added to an `AskUserQuestion` call came back as the tool's
 *   own result, and the agent carried on from it. `updatedPermissions` is honoured too: a
 *   `destination: "session"` rule had two Bash calls asked about once, against twice without.
 * - **The CLI waits indefinitely.** With a server that never answered, no `result` came for
 *   45 s and the turn stayed open. That is what lets a phone answer at its own pace.
 */
export const APPROVAL_TOOL_NAME = "approve";
export const APPROVAL_SERVER_NAME = "lotus";
/** What `--permission-prompt-tool` is given: MCP names a tool `mcp__<server>__<tool>`. */
export const APPROVAL_PROMPT_TOOL = `mcp__${APPROVAL_SERVER_NAME}__${APPROVAL_TOOL_NAME}`;

/**
 * The argument that turns this host into the approval MCP server instead of a host.
 *
 * A flag rather than an env var, and rather than a script path. `claude` spawns this process
 * itself from `--mcp-config`, so what it is handed has to be a command that works — and on a
 * compiled binary a script path is not one: it is ignored, the binary starts a second Lotus
 * host, and `mcp__lotus__approve` never registers (issue 26).
 */
export const APPROVAL_SERVER_FLAG = "--approval-server";

/** Anything a runtime would accept as "the script to run". */
const SCRIPT = /\.(mjs|cjs|js)$/;

/**
 * How to start this same host again, as the approval server.
 *
 * Two launch shapes are real and both must keep working:
 *
 * | started as | `execPath` | args |
 * |---|---|---|
 * | compiled binary (`lotus-host`, `lotus-remote-bin`) | the binary | just the flag |
 * | bundled script (`node dist/lotus-remote.mjs`) | `node` | the script, then the flag |
 *
 * Told apart by `argv[1]`: a runtime running a script has the script there, a compiled binary
 * does not. **Only `argv[1]`** — a host started with flags of its own must not pass them to a
 * child that is an MCP server and knows none of them.
 *
 * A pure function so the rule is written once and testable without a real binary; the shape
 * of `argv` inside a compiled Bun binary is exactly the thing that is awkward to assert live.
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
