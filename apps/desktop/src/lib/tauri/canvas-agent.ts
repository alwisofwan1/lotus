"use client";

/**
 * Lean adapter that runs a headless Claude agent by reusing the existing
 * `agent_cli_run` streaming command. Raw `claude-stream-json` lines (plus the
 * `_final`/`_error` wrappers) arrive via `onLine` for the caller to parse.
 */

export interface AgentStartOptions {
  prompt: string;
  model: string;
  cwd: string;
  onLine: (line: string) => void;
  /** Resume an existing Claude session (`--resume`) to continue the conversation. */
  resumeSessionId?: string;
  /** Reasoning effort (minimal..max). Defaults to "medium". */
  effort?: string;
  /** Skip permission prompts (YOLO). Defaults to true; false = read-only headless run. */
  skipPermissions?: boolean;
  /** Pasted images as base64 data-URL attachments (staged to disk by the Rust run path). */
  imageAttachments?: Array<{ name: string; content: string; mimeType?: string }>;
  /** Dropped image files already on disk — absolute paths passed straight through. */
  imagePaths?: string[];
}

export interface AgentRunner {
  /** Fires the run and resolves with its runId immediately; completion arrives via onLine. */
  start(opts: AgentStartOptions): Promise<string>;
  stop(runId: string): Promise<void>;
}

function newRunId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `agent-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

export function createTauriAgentRunner(): AgentRunner {
  const runs = new Map<string, Promise<unknown>>();
  return {
    async start({ prompt, model, cwd, onLine, resumeSessionId, effort, skipPermissions, imageAttachments, imagePaths }) {
      const { invoke, Channel } = await import("@tauri-apps/api/core");
      const runId = newRunId();
      const channel = new Channel<string>();
      channel.onmessage = onLine;
      const completion = invoke("agent_cli_run", {
        runId,
        prompt,
        agentId: runId,
        command: ["claude"],
        parser: "claude-stream-json",
        model,
        effort: effort ?? "medium",
        flash: false,
        providerSessionId: resumeSessionId ?? null,
        imageAttachments: imageAttachments ?? [],
        imagePaths: imagePaths ?? [],
        cwd,
        dangerouslySkipPermissions: skipPermissions ?? true,
        onChunk: channel,
      }).catch((err: unknown) => {
        onLine(JSON.stringify({ type: "_error", text: `Failed to start agent: ${String(err)}` }));
      }).finally(() => { runs.delete(runId); });
      runs.set(runId, completion);
      return runId;
    },
    async stop(runId) {
      const completion = runs.get(runId);
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("agent_cli_cancel", { runId });
      // Cancel-before-register is queued by Rust. Only run completion proves it has finished.
      await completion;
    },
  };
}
