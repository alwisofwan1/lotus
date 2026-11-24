import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Isolated mount whose `.claude/skills/` are exposed to a remote-scoped agent
 * session via `--add-dir`. Kept under `.lotus-remote/agent-mount` (NOT the
 * `.lotus-remote` root) so config/secrets sitting beside it are never granted
 * to the agent. See ADR-0018.
 */
export function resolveRemoteSkillMount(home: string = homedir()): string {
  return join(home, ".lotus-remote", "agent-mount");
}

/** `--add-dir <mount>` for a remote-scoped request, or `[]` otherwise. */
export function remoteSkillArgs(mount: string, remoteScoped: boolean | undefined): string[] {
  return remoteScoped ? ["--add-dir", mount] : [];
}
