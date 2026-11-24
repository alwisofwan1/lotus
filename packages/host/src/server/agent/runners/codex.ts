import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentChatRequest, AgentChatResponse, AgentRunner, AgentSpawnRequest } from "../types.js";
import { ProviderUnavailableError } from "../errors.js";
import { parseCodexJsonl } from "../codex-stream.js";
import { attachAbort } from "./process-abort.js";
import { shellArg } from "./claude.js";
import type { PtyManager } from "../../pty/manager.js";

export type ChildSpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

function runProcess(
  spawnFn: ChildSpawnFn,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ text: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      // stdin MUST be closed: codex 0.139 `exec` blocks forever on
      // "Reading additional input from stdin..." even when the prompt is passed
      // as an arg, which hangs the synchronous bridge request until the HTTP
      // client's 5-minute header timeout fires ("fetch failed").
      proc = spawnFn("codex", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new ProviderUnavailableError("codex", String(err)));
      return;
    }

    const detachAbort = attachAbort(proc, signal, reject);
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      detachAbort();
      if (err.code === "ENOENT") {
        reject(new ProviderUnavailableError("codex", "binary not found on PATH"));
      } else {
        reject(err);
      }
    });
    proc.on("close", (code) => {
      detachAbort();
      resolve({ text: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 });
    });
  });
}

/**
 * codex 0.139 always emits `thread.started` first, so stdout is never empty
 * even on failure — a non-zero exit with no agent_message would otherwise
 * yield an empty reply ("(empty response)"). When the turn failed and parsing
 * produced no text, surface stderr (or the exit code) so the cause is visible.
 */
export function finalizeCodexText(
  parsedText: string,
  stderr: string,
  exitCode: number,
  parsedIsError: boolean,
): { text: string; isError: boolean } {
  const isError = parsedIsError || exitCode !== 0;
  if (parsedText.trim() || !isError) return { text: parsedText, isError };
  const text = stderr || `codex exited with code ${exitCode} and produced no output`;
  return { text, isError: true };
}

export class CodexRunner implements AgentRunner {
  readonly providerId = "codex" as const;

  constructor(
    private readonly ptyManager: PtyManager,
    private readonly spawnFn: ChildSpawnFn = spawn,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async chat(req: AgentChatRequest): Promise<AgentChatResponse> {
    // Codex 0.139 removed `--quiet`; headless chat goes through `codex exec`
    // with JSON events we parse. Resume by codex thread id when one is given.
    const base = req.sessionId ? ["exec", "resume", req.sessionId] : ["exec"];
    const args = [...base, "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", req.prompt];
    const { text: raw, stderr, exitCode } = await runProcess(this.spawnFn, args, req.cwd, this.env, req.signal);
    const parsed = parseCodexJsonl(raw);
    const { text, isError } = finalizeCodexText(parsed.text, stderr, exitCode, parsed.isError);
    return {
      sessionId: parsed.sessionId ?? randomUUID(),
      text,
      isError,
      provider: "codex",
    };
  }

  async spawnPty(req: AgentSpawnRequest, ptySessionId: string): Promise<void> {
    // `spawn-tuning`, in codex's own two shapes. Probed against codex-cli 0.154.0 on
    // 2026-09-10: `--help` lists `-m, --model <MODEL>` and `-c, --config <key=value>`, and
    // there is **no** `--effort` — so effort travels as a config override. The key
    // `model_reasoning_effort` appears 26 times in that binary, which is what makes it a
    // fact rather than the comment in `spawn-tuning.ts` taken on trust.
    //
    // Values are not checked here and the scale is not asserted anywhere: `cell-routes.ts`
    // takes both as free text because only the CLI can judge them, and codex carries
    // `supported_reasoning_levels` **per model** — so a global list could only ever be an
    // approximation. Quoted through the same helper claude uses, for the same reason: this
    // command is typed into a PTY and a shell will split it.
    const flags: string[] = [];
    if (req.model) flags.push("-m", shellArg(req.model));
    if (req.effort) flags.push("-c", `model_reasoning_effort=${shellArg(req.effort)}`);
    this.ptyManager.write(
      ptySessionId,
      `codex${flags.length > 0 ? ` ${flags.join(" ")}` : ""}\n`,
    );
  }
}
