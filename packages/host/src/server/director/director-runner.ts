import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { ProviderUnavailableError } from "../agent/errors.js";
import { parseStreamJson } from "../agent/stream-json.js";
import { parseCodexJsonl } from "../agent/codex-stream.js";
import { finalizeCodexText } from "../agent/runners/codex.js";
import type { LotusMcpConfigInput } from "./mcp-config.js";

/**
 * Drives the Headless Director's agent CLI: one event per invocation, resuming
 * a persistent session, with the Lotus MCP tools loaded so the agent can
 * orchestrate the fleet. Provider-portable by design (ADR-0020) — claude is
 * implemented here; codex slots in behind {@link DirectorRunner} (Slice 7,
 * pending the live MCP-injection spike).
 */
export type DirectorProvider = "claude" | "codex";

export interface DirectorInvokeRequest {
  /** The event/prompt for this turn (goal submitted, worker idle, …). */
  event: string;
  /** Stable session id: forced on the first turn, resumed thereafter. */
  sessionId: string;
  /** Working directory for the Director process. */
  cwd: string;
  /** false → first turn (`--session-id`); true → resume (`--resume`). */
  resume: boolean;
}

export interface DirectorInvokeResult {
  sessionId: string;
  text: string;
  isError: boolean;
}

export interface DirectorRunner {
  readonly provider: DirectorProvider;
  invoke(req: DirectorInvokeRequest): Promise<DirectorInvokeResult>;
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Generous safety-net ceiling for one Director turn. A turn legitimately blocks
 * for many minutes inside `lotus_wait_cell_idle` while workers run, so this is
 * NOT a tight bound — it only kills a genuinely-hung process (network deadlock,
 * stdin wait) that would otherwise block the serialized turn queue forever. A
 * hung process is stuck on I/O and not spending tokens, so the kill is cheap.
 */
export const DEFAULT_DIRECTOR_TURN_TIMEOUT_MS = 30 * 60_000;

interface ProcResult { stdout: string; stderr: string; exitCode: number }

function runProcess(
  spawnFn: SpawnFn,
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      // stdin MUST be closed: `codex exec` (and other CLIs) block forever on
      // "Reading additional input from stdin..." in a headless host with no
      // attached terminal, hanging the whole serialized turn queue.
      proc = spawnFn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new ProviderUnavailableError(file, String(err)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill?.("SIGTERM");
      reject(new Error(`${file} Director turn exceeded ${timeoutMs}ms timeout`));
    }, timeoutMs);
    proc.stdout?.on("data", (c: Buffer | string) => { stdout += typeof c === "string" ? c : c.toString("utf8"); });
    proc.stderr?.on("data", (c: Buffer | string) => { stderr += typeof c === "string" ? c : c.toString("utf8"); });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new ProviderUnavailableError(file, "binary not found on PATH") : err);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr.trim(), exitCode: code ?? 1 });
    });
  });
}

/** Claude error-subtype lines omit `result`; synthesize one from stderr so the parser surfaces the cause. */
function claudeRawOrStderr({ stdout, stderr }: ProcResult): string {
  if (stdout.trim() || !stderr) return stdout;
  return `{"type":"result","subtype":"error","session_id":"","result":${JSON.stringify(stderr)},"is_error":true}`;
}

export class ClaudeDirectorRunner implements DirectorRunner {
  readonly provider = "claude" as const;

  constructor(
    /** Lotus MCP server config — inline JSON or a file path (`--mcp-config`). */
    private readonly mcpConfig: string,
    /** Orchestrator system prompt appended to claude's default (`--append-system-prompt`). */
    private readonly systemPrompt: string,
    private readonly spawnFn: SpawnFn = spawn,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly timeoutMs: number = DEFAULT_DIRECTOR_TURN_TIMEOUT_MS,
  ) {}

  async invoke(req: DirectorInvokeRequest): Promise<DirectorInvokeResult> {
    const args = [
      "--dangerously-skip-permissions",
      "--print", "--output-format", "stream-json", "--verbose",
      "--mcp-config", this.mcpConfig, "--strict-mcp-config",
      "--append-system-prompt", this.systemPrompt,
      ...(req.resume ? ["--resume", req.sessionId] : ["--session-id", req.sessionId]),
      req.event,
    ];
    const proc = await runProcess(this.spawnFn, "claude", args, req.cwd, this.env, this.timeoutMs);
    const { sessionId, text, isError } = parseStreamJson(claudeRawOrStderr(proc));
    return { sessionId: sessionId || req.sessionId, text, isError };
  }
}

/**
 * Codex Director runtime (ADR-0020). Differs from claude: MCP is injected via
 * `-c mcp_servers.lotus.*` TOML overrides (no `--mcp-config` flag), there is no
 * forced session id (codex mints its own `thread_id`, which we parse and the
 * supervisor persists for `resume`), and the system prompt is prepended to the
 * first turn since codex has no `--append-system-prompt`.
 */
export class CodexDirectorRunner implements DirectorRunner {
  readonly provider = "codex" as const;

  constructor(
    private readonly systemPrompt: string,
    private readonly mcp: LotusMcpConfigInput,
    private readonly spawnFn: SpawnFn = spawn,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly timeoutMs: number = DEFAULT_DIRECTOR_TURN_TIMEOUT_MS,
  ) {}

  async invoke(req: DirectorInvokeRequest): Promise<DirectorInvokeResult> {
    const prompt = req.resume ? req.event : `${this.systemPrompt}\n\n${req.event}`;
    const args = ["exec"];
    if (req.resume) args.push("resume", req.sessionId);
    args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
    args.push("-c", `mcp_servers.lotus.command=${JSON.stringify(this.mcp.sidecarCommand)}`);
    args.push("-c", `mcp_servers.lotus.args=${JSON.stringify([this.mcp.sidecarPath, "--discovery", this.mcp.discoveryPath])}`);
    args.push(prompt);

    const proc = await runProcess(this.spawnFn, "codex", args, req.cwd, this.env, this.timeoutMs);
    const parsed = parseCodexJsonl(proc.stdout);
    // Parity with the bridge CodexRunner: codex always emits `thread.started`, so
    // stdout is never empty even on failure — fold in stderr / exit code when the
    // turn produced no assistant text so the Director never relays an empty reply.
    const { text, isError } = finalizeCodexText(parsed.text, proc.stderr, proc.exitCode, parsed.isError);
    return { sessionId: parsed.sessionId ?? req.sessionId, text, isError };
  }
}
