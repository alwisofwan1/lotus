import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";
import type { CliToolBackendAvailability, CliToolId } from "@/modules/codespace/services/cli-tools";
import type { SshTarget } from "@/modules/codespace/services/ssh-command";

export async function getCliToolAvailability(
  toolIds: CliToolId[],
): Promise<CliToolBackendAvailability[]> {
  if (!isTauri()) {
    return toolIds.map((id) => ({ id, installed: false }));
  }

  return tauriInvoke<CliToolBackendAvailability[]>("get_cli_tool_availability", {
    toolIds,
  });
}

export async function getSshCliToolAvailability(
  target: SshTarget,
  toolIds: CliToolId[],
): Promise<CliToolBackendAvailability[]> {
  if (!isTauri()) {
    return toolIds.map((id) => ({ id, installed: false }));
  }

  return tauriInvoke<CliToolBackendAvailability[]>("get_ssh_cli_tool_availability", {
    target,
    toolIds,
  });
}

export async function getSshGitRepoRoot(
  target: SshTarget,
  remoteCwd?: string | null,
): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }

  return tauriInvoke<string | null>("get_ssh_git_repo_root", {
    target,
    remoteCwd: remoteCwd ?? null,
  });
}
