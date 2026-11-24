/**
 * Builds the `--mcp-config` JSON that wires the Lotus MCP sidecar into a
 * Director CLI invocation, pointing it at this host's `/v1/*` discovery file.
 * Returned as an inline JSON string (claude `--mcp-config` accepts inline JSON).
 */
export interface LotusMcpConfigInput {
  /** Executable that runs the sidecar (e.g. "bun" or "node"). */
  sidecarCommand: string;
  /** Absolute path to the vendored `lotus-mcp-server.mjs`. */
  sidecarPath: string;
  /** Absolute path to this host's `lotus-mcp-ipc.json` discovery file. */
  discoveryPath: string;
}

export function buildLotusMcpConfig(input: LotusMcpConfigInput): string {
  return JSON.stringify({
    mcpServers: {
      lotus: {
        type: "stdio",
        command: input.sidecarCommand,
        args: [input.sidecarPath, "--discovery", input.discoveryPath],
      },
    },
  });
}
