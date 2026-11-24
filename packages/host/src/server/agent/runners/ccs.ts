import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentChatRequest, AgentChatResponse, AgentRunner, AgentSpawnRequest } from "../types.js";
import { ProviderUnavailableError } from "../errors.js";
import { trustProjectFolder } from "../../../core/claude-trust.js";
import type { PtyManager } from "../../pty/manager.js";
import { paneOf, sleep, typeInitialPrompt } from "../tui-prompt.js";
import { permissionFlags, tuningFlags } from "./claude.js";

export type ChildSpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

function runProcess(
  spawnFn: ChildSpawnFn,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ text: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawnFn("ccs", args, { cwd, env });
    } catch (err) {
      reject(new ProviderUnavailableError("ccs", String(err)));
      return;
    }

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new ProviderUnavailableError("ccs", "binary not found on PATH"));
      } else {
        reject(err);
      }
    });
    proc.on("close", (code) => resolve({ text: stdout.trim(), exitCode: code ?? 1 }));
  });
}

export class CcsRunner implements AgentRunner {
  readonly providerId: `ccs:${string}`;

  constructor(
    private readonly account: string,
    private readonly ptyManager: PtyManager,
    private readonly spawnFn: ChildSpawnFn = spawn,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.providerId = `ccs:${account}`;
  }

  async chat(req: AgentChatRequest): Promise<AgentChatResponse> {
    const accountArg = req.sessionId ? `${this.account}:continue` : this.account;
    const { text, exitCode } = await runProcess(
      this.spawnFn,
      [accountArg, "-p", req.prompt],
      req.cwd,
      this.env,
    );
    return {
      sessionId: randomUUID(),
      text,
      isError: exitCode !== 0,
      provider: `ccs:${this.account}`,
    };
  }

  async spawnPty(req: AgentSpawnRequest, ptySessionId: string): Promise<void> {
    // A ccs account picks its own config dir — `~/.ccs/instances/<account>` — so the trust
    // record has to be written there and not wherever this host's own env points.
    trustProjectFolder({
      configDir: join(homedir(), ".ccs", "instances", this.account),
      cwd: req.cwd,
    });
    // `ccs --help` (v8.7.0): `ccs <profile> [claude-args...]` — the wrapper forwards claude's
    // own flags, so tuning is the same two flags a native claude cell takes. Imported from
    // `claude.ts` rather than rebuilt: the quoting rule is the load-bearing part, and a second
    // copy is how one of them comes to lack it.
    // Posture first, then tuning — the same order a native claude cell writes them.
    //
    // The posture was dropped here entirely until 2026-09-11, while `fleet.ts:199` reported
    // one anyway: `runnerFamily("ccs:x")` answers `provider: "claude"`, so `gatingFor` derived
    // `asks`/`skipped` from the mode stored at spawn. A cell picked as `yolo` was shown with
    // its gate off and still asked, and then waited at a prompt the phone believed could not
    // happen. What is launched has to be what the fleet claims (ADR-8).
    //
    // Imported rather than rebuilt, like `tuningFlags`: `permissionFlags` and `gatingFor` are
    // two halves of one rule, and a second copy is how one half comes to drift.
    const flags = [...permissionFlags(req.permissionMode), ...tuningFlags(req.model, req.effort)];
    this.ptyManager.write(
      ptySessionId,
      `ccs ${this.account}${flags.length > 0 ? ` ${flags.join(" ")}` : ""}\n`,
    );
    if (req.prompt) {
      // Dropped silently until 2026-09-07: a ccs cell spawned with an opening prompt typed the
      // command and nothing else. Same handover to wait for — `ccs` runs the same TUI.
      void typeInitialPrompt(paneOf(this.ptyManager, ptySessionId), req.prompt, { sleep });
    }
  }
}
