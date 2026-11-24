import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/**
 * Headless agent CLI runs (`src-tauri/src/agent_cli`): availability, model discovery, image staging
 * and cancel. Mode-neutral — Canvas, Smart Convert and Tasks use it; it was CodeChat's (07g).
 * The run itself streams through `agent_cli_run` (see `canvas-agent.ts`).
 */

/** Mirrors the Rust `agent_cli::ImageAttachment` (base64 data URL transport). */
export interface AgentCliImageAttachment {
  name: string;
  content: string;
  mimeType?: string;
}

export interface AgentCliAvailability {
  available: boolean;
  resolvedPath?: string | null;
  source?: string | null;
  message?: string | null;
  authState?: "authenticated" | "not-authenticated" | "unknown" | null;
  authMessage?: string | null;
}

export interface AgentCliModels {
  models: string[];
  defaultModel?: string | null;
  efforts?: string[];
}

export interface AgentCliStagedImages {
  tempDir: string;
  imagePaths: string[];
}

export async function getAgentCliAvailability(
  command: string[],
  options: { probeAuth?: boolean } = {},
): Promise<AgentCliAvailability> {
  if (!isTauri()) {
    return {
      available: false,
      resolvedPath: null,
      message: "Desktop app required for command availability checks.",
    };
  }

  return tauriInvoke<AgentCliAvailability>("agent_cli_availability", {
    command,
    probeAuth: options.probeAuth ?? true,
  });
}

export async function discoverAgentCliModels(
  agentId: string,
  command: string[],
): Promise<AgentCliModels> {
  if (!isTauri()) {
    return { models: [], defaultModel: null };
  }

  return tauriInvoke<AgentCliModels>("agent_cli_models", {
    agentId,
    command,
  });
}

export async function stageAgentCliImages(
  attachments: AgentCliImageAttachment[],
): Promise<AgentCliStagedImages> {
  return tauriInvoke<AgentCliStagedImages>("agent_cli_stage_images", {
    attachments,
  });
}

export async function cleanupAgentCliTempDir(tempDir: string): Promise<void> {
  return tauriInvoke("agent_cli_cleanup_temp_dir", { tempDir });
}

export async function cancelAgentCliRun(runId: string): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }

  return tauriInvoke<boolean>("agent_cli_cancel", { runId });
}
