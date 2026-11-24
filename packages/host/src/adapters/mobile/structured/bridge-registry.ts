import type { BridgeProvider } from "../../../types/api.js";
import type { ProviderBridgeFactory } from "../../../types/provider-bridge.js";
import { acpBridges, type CreateAcpSession } from "./bridges/acp/index.js";
import { claudeBridge, type CreateClaudeSession } from "./bridges/claude/index.js";
import { codexBridge, type CreateCodexSession } from "./bridges/codex.js";

/**
 * Which runners this host can start without a terminal — the one place that knows the whole
 * list, so adding a bridge is an entry here rather than an edit to the store.
 */
export interface BridgeRegistryOptions {
  /** Test seam: replaces how a Codex session is constructed, not which runners exist. */
  createCodexSession?: CreateCodexSession;
  /** The same seam for every ACP agent. */
  createAcpSession?: CreateAcpSession;
  /** And for Claude over `stream-json`. */
  createClaudeSession?: CreateClaudeSession;
  /** Where Chat Attachment copies live, so Claude may read them. */
  readableDir?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export class BridgeRegistry {
  private readonly factories: ProviderBridgeFactory[];

  constructor(private readonly opts: BridgeRegistryOptions = {}) {
    this.factories = [
      claudeBridge(opts.createClaudeSession, opts.readableDir),
      codexBridge(opts.createCodexSession),
      ...acpBridges(opts.createAcpSession),
    ];
  }

  /** Every runner this host could start, installed or not. */
  all(): readonly ProviderBridgeFactory[] {
    return this.factories;
  }

  /** Only the ones whose binary is actually here. */
  available(): ProviderBridgeFactory[] {
    return this.factories.filter((f) => f.available(this.opts.env));
  }

  /** `undefined` covers both "no bridge for that" and "binary not installed" — both are a spawn that must not be attempted. */
  find(agentType: BridgeProvider): ProviderBridgeFactory | undefined {
    return this.available().find((f) => f.agentType === agentType);
  }

  /** Whether this host should advertise structured spawn at all. */
  anyAvailable(): boolean {
    return this.available().length > 0;
  }
}
