import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { AgentChatRequest, AgentChatResponse, AgentRunner, AgentSpawnRequest } from "../types.js";
import { ProviderUnavailableError } from "../errors.js";
import { parseStreamJson } from "../stream-json.js";
import { remoteSkillArgs, resolveRemoteSkillMount } from "../remote-skills.js";
import { LOTUS_AGENT_PERSONA } from "../persona.js";
import { attachAbort } from "./process-abort.js";
import { resolveClaudeConfigDir, trustProjectFolder } from "../../../core/claude-trust.js";
import type { PtyManager } from "../../pty/manager.js";
import { paneOf, sleep, typeInitialPrompt } from "../tui-prompt.js";

export type ChildSpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

/** True when claude rejected a `--resume` id because the conversation is gone. */
function isStaleSessionError(text: string): boolean {
  return /No conversation found with session ID/i.test(text);
}

function runProcess(
  spawnFn: ChildSpawnFn,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      // Close stdin: the prompt is passed as an arg, so claude has no input to
      // read — leaving stdin open makes it wait ~3s ("no stdin data received")
      // before proceeding, adding that latency to every bridge turn.
      proc = spawnFn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new ProviderUnavailableError("claude", String(err)));
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
        reject(new ProviderUnavailableError("claude", "binary not found on PATH"));
      } else {
        reject(err);
      }
    });
    proc.on("close", () => {
      detachAbort();
      // When stdout is empty but stderr has content, surface stderr so
      // parseStreamJson returns it as error text rather than silent empty.
      if (!stdout.trim() && stderr.trim()) {
        resolve(`{"type":"result","subtype":"error","session_id":"","result":${JSON.stringify(stderr.trim())},"is_error":true}`);
      } else {
        resolve(stdout);
      }
    });
  });
}

export class ClaudeRunner implements AgentRunner {
  readonly providerId = "claude" as const;

  constructor(
    private readonly ptyManager: PtyManager,
    private readonly spawnFn: ChildSpawnFn = spawn,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly remoteSkillMount: string = resolveRemoteSkillMount(),
    /** Lotus agent identity appended to claude's base prompt (ADR-0018 persona). */
    private readonly systemPrompt: string = LOTUS_AGENT_PERSONA,
  ) {}

  async chat(req: AgentChatRequest): Promise<AgentChatResponse> {
    const first = await this.runChat(req, req.sessionId ?? null);
    // A stale/expired --resume id makes claude exit "No conversation found with
    // session ID: <id>" AND echo the dead id back, so a naive caller re-persists
    // it and loops forever. Recover by retrying once with a fresh session.
    if (req.sessionId && first.isError && isStaleSessionError(first.text)) {
      return this.runChat(req, null);
    }
    return first;
  }

  private async runChat(req: AgentChatRequest, sessionId: string | null): Promise<AgentChatResponse> {
    const args = ["--dangerously-skip-permissions", "--print", "--output-format", "stream-json", "--verbose"];
    if (sessionId) args.push("--resume", sessionId);
    if (req.model) args.push("--model", req.model);
    if (this.systemPrompt) args.push("--append-system-prompt", this.systemPrompt);
    // Prompt MUST come before --add-dir: claude's --add-dir is variadic and
    // would otherwise swallow the trailing prompt as another directory, leaving
    // "Input must be provided" (regression from ADR-0018's --add-dir injection).
    args.push(req.prompt);
    args.push(...remoteSkillArgs(this.remoteSkillMount, req.remoteScoped));

    const raw = await runProcess(this.spawnFn, args, req.cwd, this.env, req.signal);
    const { sessionId: sid, text, isError } = parseStreamJson(raw);

    return { sessionId: sid, text, isError, provider: "claude" };
  }

  async spawnPty(req: AgentSpawnRequest, ptySessionId: string): Promise<void> {
    // Before the command is typed, not after: the trust dialog is a first-run gate the phone
    // can neither see nor safely answer (`core/claude-trust.ts`), so it has to be gone before
    // the agent draws it.
    trustProjectFolder({
      configDir: req.configDir ?? resolveClaudeConfigDir(req.configDir === null ? {} : this.env, homedir()),
      cwd: req.cwd,
    });
    const flags = [
      ...permissionFlags(req.permissionMode),
      ...tuningFlags(req.model, req.effort),
      ...remoteSkillArgs(this.remoteSkillMount, req.remoteScoped),
    ];
    // No flags is not a degenerate case: it is claude's default, which asks per action —
    // and a trailing space would be a second argv entry to the shell.
    this.ptyManager.write(ptySessionId, `${accountPrefix(req.configDir)}claude${flags.length > 0 ? ` ${flags.join(" ")}` : ""}\n`);
    if (req.prompt) {
      // Not awaited: the opening prompt waits for the TUI to take the terminal, and a spawn
      // call must answer before then. Fire-and-forget is the same choice the conversation lane
      // makes for a dispatch.
      void typeInitialPrompt(paneOf(this.ptyManager, ptySessionId), req.prompt, { sleep });
    }
  }
}

/**
 * `spawn-tuning`, as argv.
 *
 * Both flags probed against the installed CLI on 2026-09-10 rather than taken from a doc:
 * `claude --help` lists `--model <model>` and `--effort <level> (low, medium, high, xhigh,
 * max)`. The effort scale matches {@link CLAUDE_EFFORTS} exactly, so what the phone is
 * offered is what the binary takes.
 *
 * **Values are quoted, and this line is where that matters.** The command is *typed into a
 * PTY*, so a shell splits it — an alias carrying a space would arrive as a second argv entry
 * and claude would read it as a path. Nothing upstream can prevent that: `cell-routes.ts`
 * takes both as free text on purpose, because only the CLI can judge an alias.
 *
 * Absent stays absent. No flag is claude's own default, which is the whole reason
 * `permissionFlags` is allowed to return nothing.
 */
export function tuningFlags(model: string | undefined, effort: string | undefined): string[] {
  const out: string[] = [];
  if (model) out.push("--model", shellArg(model));
  if (effort) out.push("--effort", shellArg(effort));
  return out;
}

/** The account, as the typed command's env: the shell the cell runs in may carry another one. */
function accountPrefix(configDir: string | null | undefined): string {
  if (configDir === undefined) return "";
  return configDir === null ? "env -u CLAUDE_CONFIG_DIR " : `CLAUDE_CONFIG_DIR=${shellArg(configDir)} `;
}

/** POSIX single-quoting: safe for anything, and `'` itself closes-escapes-reopens. */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9._\/-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The command-line half of the posture. `gatingFor` is the reporting half, and the two
 * must not drift: what is launched is what the fleet claims (ADR-8).
 *
 * - `bypassPermissions` / `yolo` — the gate off. `yolo` is the phone's word for it.
 * - `safe` — the phone's word for `manual`, passed explicitly like any other.
 * - anything else — handed to `--permission-mode` as given, because the scale is advertised from
 *   `CLAUDE_PERMISSIONS` rather than hardcoded on either side, and the CLI is the only thing that
 *   can finally judge a value.
 * - nothing chosen — no flag, and `gatingFor` then reports **unknown** rather than `asks`.
 *
 * **`manual` is passed, never assumed.** It was left implicit until 2026-09-06, on the reasoning
 * that it is what claude does with no flag. Measured on devbox-vps that day: a cell spawned with
 * `permissionMode: "manual"` came up `⏵⏵ auto mode on`, because the effective mode can come from
 * state this host cannot see. The flag is one argument; a fleet that says `asks` about a cell that
 * does not is the failure ADR-8 calls unrecoverable once the cell is running.
 */
export function permissionFlags(mode: string | undefined): string[] {
  if (mode === undefined) return [];
  if (mode === "bypassPermissions" || mode === "yolo") return ["--dangerously-skip-permissions"];
  return ["--permission-mode", shellArg(mode === "safe" ? "manual" : mode)];
}
