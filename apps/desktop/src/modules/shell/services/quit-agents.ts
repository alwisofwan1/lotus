import { tauriInvoke } from "@/lib/tauri/runtime";

/** What happens to agents in the session daemon when Lotus quits (`quit_guard.rs`). */
export type QuitChoice = "keep" | "stop";

export interface RunningAgent {
  agent: string;
  cwd: string;
}

/** Sent by `applicationShouldTerminate:` when a quit was stopped to ask. */
export const QUIT_AGENTS_EVENT = "lotus://quit-agents-running";

/** Sent instead when the agents run inside Lotus (session service down) and would stop. */
export const QUIT_AGENTS_WILL_STOP_EVENT = "lotus://quit-agents-will-stop";

/** Sent when the session service could not be reached; ask [`takeSessiondFallback`] then. */
export const SESSIOND_FALLBACK_EVENT = "lotus://sessiond-fallback";

/** True once per run when agents run inside Lotus because the session service is down. */
export function takeSessiondFallback(): Promise<boolean> {
  return tauriInvoke<boolean>("take_sessiond_fallback");
}

/** `null` = Cancel: Lotus stays open. */
export function answerQuit(choice: QuitChoice | null, remember: boolean): Promise<void> {
  return tauriInvoke("quit_with_agents", { choice, remember });
}

/** `null` = ask on quit. */
export function getQuitChoice(): Promise<QuitChoice | null> {
  return tauriInvoke<QuitChoice | null>("get_quit_choice");
}

export function setQuitChoice(choice: QuitChoice | null): Promise<void> {
  return tauriInvoke("set_quit_choice", { choice });
}

/** Once per start: agents kept running at the last quit that are still alive. */
export function takeKeptAgents(): Promise<number> {
  return tauriInvoke<number>("take_kept_agents");
}

export function agentsLabel(count: number): string {
  return count === 1 ? "1 agent is still running" : `${count} agents are still running`;
}
