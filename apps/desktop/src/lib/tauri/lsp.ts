import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";

/** `editor_lsp.rs`: which server a file gets, and where it is. */
export type LspResolution = {
  serverId: string;
  label: string;
  projectRoot: string;
  /** Absolute path of the server; `null` when it is not installed. */
  command: string | null;
  installHint: string;
};

export type LspEvent =
  | { kind: "message"; data: string }
  | { kind: "exit"; code: number | null; stderr: string };

function sshTarget(location: Extract<CodeSpaceStoredWorkspaceLocation, { kind: "ssh" }>) {
  const host = location.host?.trim();
  if (!host) throw new Error("This SSH workspace has no host");
  return { host, user: location.user?.trim() || null, port: typeof location.port === "number" ? location.port : null };
}

export async function editorLspResolve(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  serverId: string,
  filePath: string,
  rootDir: string,
): Promise<LspResolution> {
  if (!isTauri()) throw new Error("Language servers run only in the desktop app");
  if (location?.kind === "ssh") {
    return tauriInvoke<LspResolution>("editor_lsp_resolve_ssh", { target: sshTarget(location), serverId, filePath, rootDir });
  }
  return tauriInvoke<LspResolution>("editor_lsp_resolve", { serverId, filePath, rootDir });
}

/** Starts a server a resolve found. Returns its session id. */
export async function editorLspStart(
  location: CodeSpaceStoredWorkspaceLocation | null | undefined,
  command: string,
  projectRoot: string,
  onEvent: (event: LspEvent) => void,
): Promise<string> {
  if (!isTauri()) throw new Error("Language servers run only in the desktop app");
  const { Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<LspEvent>();
  channel.onmessage = onEvent;
  if (location?.kind === "ssh") {
    return tauriInvoke<string>("editor_lsp_start_ssh", { target: sshTarget(location), command, projectRoot, onEvent: channel });
  }
  return tauriInvoke<string>("editor_lsp_start", { command, projectRoot, onEvent: channel });
}

export function editorLspSend(sessionId: string, message: string): Promise<void> {
  return tauriInvoke<void>("editor_lsp_send", { sessionId, message });
}

export async function editorLspStop(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("editor_lsp_stop", { sessionId });
}
