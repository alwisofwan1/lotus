import { homedir } from "node:os";
import { join } from "node:path";

/** Expose only the skill mount to agents so neighboring configuration and secrets stay private (ADR-0018). */
export function resolveRemoteSkillMount(home: string = homedir()): string {
  return join(home, ".lotus-remote", "agent-mount");
}

/** `--add-dir <mount>` for a remote-scoped request, or `[]` otherwise. */
export function remoteSkillArgs(mount: string, remoteScoped: boolean | undefined): string[] {
  return remoteScoped ? ["--add-dir", mount] : [];
}
