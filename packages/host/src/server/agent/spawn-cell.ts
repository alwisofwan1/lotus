import type { CreateSessionRequest } from "../../types/index.js";
import type { PtyManager } from "../pty/manager.js";
import type { PtySessionState } from "../pty/types.js";
import type { AgentRunner, AgentSpawnRequest } from "./types.js";

/**
 * Creates a PTY session and spawns the agent into it. If the runner fails, the
 * orphaned session is killed before the error propagates. Shared by the
 * `/api/agent/spawn-pty` route and the `/v1/spawn-cell` MCP-IPC endpoint so the
 * create→spawn→cleanup sequence lives in exactly one place.
 */
export async function spawnCell(
  ptyManager: PtyManager,
  runner: AgentRunner,
  create: CreateSessionRequest,
  spawn: AgentSpawnRequest,
): Promise<PtySessionState> {
  const state = ptyManager.create(create);
  try {
    await runner.spawnPty(spawn, state.id);
    return state;
  } catch (err) {
    try {
      ptyManager.kill(state.id);
    } catch {
      // session already gone — nothing to clean up
    }
    throw err;
  }
}
