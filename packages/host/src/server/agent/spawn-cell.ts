import type { CreateSessionRequest } from "../../types/index.js";
import type { PtyManager } from "../pty/manager.js";
import type { PtySessionState } from "../pty/types.js";
import type { AgentRunner, AgentSpawnRequest } from "./types.js";

/** Clean up the PTY if the runner fails to start so callers cannot leave orphan sessions. */
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
