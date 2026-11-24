import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProviderId, AgentRunner } from "./types.js";
import type { PtyManager } from "../pty/manager.js";
import { ClaudeRunner } from "./runners/claude.js";
import { CodexRunner } from "./runners/codex.js";
import { CcsRunner } from "./runners/ccs.js";
import { discoverCcsAccounts } from "./ccs-discovery.js";

export class AgentRunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  register(runner: AgentRunner): void {
    this.runners.set(runner.providerId, runner);
  }

  get(providerId: AgentProviderId): AgentRunner | undefined {
    return this.runners.get(providerId);
  }

  list(): AgentProviderId[] {
    return [...this.runners.keys()] as AgentProviderId[];
  }

  /** Builds a registry with all built-in and auto-discovered runners. */
  static build(ptyManager: PtyManager): AgentRunnerRegistry {
    const reg = new AgentRunnerRegistry();
    reg.register(new ClaudeRunner(ptyManager));
    reg.register(new CodexRunner(ptyManager));

    const ccsConfig = join(homedir(), ".ccs", "config.yaml");
    for (const account of discoverCcsAccounts(ccsConfig)) {
      reg.register(new CcsRunner(account, ptyManager));
    }

    return reg;
  }
}
