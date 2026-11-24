import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface McpIpcDiscovery {
  port: number;
  secret: string;
}

/**
 * Writes the `{ port, secret }` discovery file the MCP sidecar reads (via its
 * `--discovery <path>` flag) to reach this Standalone Orchestrator's `/v1/*`
 * surface. Written 0600 — it carries the Bearer secret. See ADR-0019.
 */
export function writeMcpIpcDiscovery(path: string, discovery: McpIpcDiscovery): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(discovery, null, 2), "utf8");
  chmodSync(path, 0o600);
}

/** Best-effort removal of the discovery file on host shutdown. */
export function removeMcpIpcDiscovery(path: string): void {
  rmSync(path, { force: true });
}
