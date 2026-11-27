import { spawn, type ChildProcess } from "node:child_process";
import { agentSpawnEnv } from "../../../../../core/agent-env.js";

import type { PromptAttachment, ProviderBridgeSession } from "../../../../../types/provider-bridge.js";
import { acpPrompt } from "../prompt-blocks.js";
import { JsonRpcError, JsonRpcStdio, type JsonRpcServerRequest } from "../../jsonrpc-stdio.js";
import { AcpConversation } from "./conversation.js";
import type { AcpAgentDefinition } from "./known-agents.js";
import { isRecord } from "./parts.js";

/**
 * One ACP agent over stdio. `session/prompt` is a **request open for the whole turn** (Codex's
 * `turn/start` returns at once), so `prompt()` resolves when the turn *ends*. Agent specifics
 * all come from [`AcpAgentDefinition`].
 */
export interface AcpSessionOptions {
  paneId: string;
  cwd: string;
  agent: AcpAgentDefinition;
  /** A stop on this runner's scale. `read-only` picks the agent's read-only mode, if it has one. */
  permissionMode?: string;
  model?: string;
  /** The binary, so a test can point at a fake. */
  command?: string;
  args?: string[];
}

export class AcpSession implements ProviderBridgeSession {
  readonly conversation: AcpConversation;
  private readonly child: ChildProcess;
  private readonly rpc: JsonRpcStdio;
  private sessionId: string | undefined;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  /** Open `session/request_permission` requests, by our own request id. */
  private readonly approvals = new Map<string, (optionId: string) => void>();
  private nextApproval = 0;

  constructor(private readonly opts: AcpSessionOptions) {
    const { agent } = opts;
    this.conversation = new AcpConversation(opts.paneId, agent.agentType);
    this.child = spawn(opts.command ?? agent.command, opts.args ?? agent.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: agentSpawnEnv(process.env, { LOTUS_PANE_ID: opts.paneId }),
    });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
    });
    if (this.child.stdout === null || this.child.stdin === null) {
      throw new Error(`${agent.command}: stdio pipes were not created`);
    }
    this.rpc = new JsonRpcStdio(this.child.stdout, this.child.stdin, agent.command);
    this.rpc.onNotification((n) => {
      if (n.method !== "session/update") return;
      const params = isRecord(n.params) ? n.params : {};
      const update = params["update"];
      if (isRecord(update) && typeof update["sessionUpdate"] === "string") {
        this.conversation.apply({ ...update, sessionUpdate: update["sessionUpdate"] });
      }
    });
    this.rpc.onServerRequest((req) => this.onServerRequest(req));
  }

  get alive(): boolean {
    return this.exited === undefined;
  }

  get thread(): string | undefined {
    return this.sessionId;
  }

  async start(): Promise<void> {
    const init = (await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })) as { authMethods?: Array<{ id?: unknown }> };
    const methodId = pickAuthMethod(init.authMethods, this.opts.agent.authMethodIds);
    if (methodId !== undefined) {
      try {
        await this.rpc.request("authenticate", { methodId });
      } catch (err) {
        // The agent is installed but nobody has signed in. Naming the command is the whole
        // difference between a fixable message and a cell that just fails to start.
        throw new Error(
          `${this.opts.agent.runnerLabel} is not signed in — run \`${this.opts.agent.signInCommand}\`` +
            ` (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    const session = (await this.rpc.request("session/new", {
      cwd: this.opts.cwd,
      mcpServers: [],
    })) as { sessionId?: unknown };
    if (typeof session.sessionId !== "string") throw new Error("session/new returned no sessionId");
    this.sessionId = session.sessionId;
    await this.applyMode();
    await this.applyModel();
  }

  /** One operator ask → one turn. Resolves when the turn **ends**, which is what ACP reports. */
  async prompt(text: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    if (this.sessionId === undefined) throw new Error("session not started");
    this.conversation.openTurn(text);
    try {
      const result = (await this.rpc.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: attachments.length === 0 ? [{ type: "text", text }] : acpPrompt(text, attachments),
      })) as { stopReason?: unknown };
      this.conversation.closeTurn(typeof result.stopReason === "string" ? result.stopReason : undefined);
    } catch (err) {
      this.conversation.closeTurn(undefined, err instanceof Error ? err.message : String(err));
    }
  }

  async interrupt(): Promise<void> {
    if (this.sessionId === undefined) return;
    await this.rpc.request("session/cancel", { sessionId: this.sessionId }).catch(() => undefined);
  }

  decide(key: string): boolean {
    const pending = this.conversation.pendingPermission();
    if (pending === undefined) return false;
    const optionId = this.conversation.decide(pending.requestId, key);
    const answer = this.approvals.get(pending.requestId);
    if (optionId === undefined || answer === undefined) return false;
    this.approvals.delete(pending.requestId);
    answer(optionId);
    return true;
  }

  close(): void {
    this.child.kill();
  }

  /**
   * A read-only ask becomes the agent's read-only mode, because these agents do not ask.
   *
   * A failure must not pass silently: the caller would get a cell with full write access.
   */
  private async applyMode(): Promise<void> {
    const modeId = this.opts.permissionMode === "read-only" ? this.opts.agent.readOnlyModeId : undefined;
    if (modeId === undefined || this.sessionId === undefined) return;
    await this.rpc.request("session/set_mode", { sessionId: this.sessionId, modeId });
  }

  private async applyModel(): Promise<void> {
    if (this.opts.model === undefined || this.sessionId === undefined) return;
    await this.rpc
      .request("session/set_model", { sessionId: this.sessionId, modelId: this.opts.model })
      .catch(() => undefined);
  }

  /**
   * `session/request_permission` stays unresolved until the phone answers (the agent waits).
   * Anything else gets `-32601`, not a drop, so it errors instead of going silent.
   */
  private async onServerRequest(req: JsonRpcServerRequest): Promise<unknown> {
    if (req.method !== "session/request_permission") {
      throw new JsonRpcError(-32601, `unsupported server request ${req.method}`);
    }
    const requestId = `perm-${this.nextApproval++}`;
    const part = this.conversation.requestPermission(requestId, req.params);
    if (part === undefined || part.options.length === 0) {
      return { outcome: { outcome: "cancelled" } };
    }
    return new Promise<unknown>((resolve) => {
      this.approvals.set(requestId, (optionId) => resolve({ outcome: { outcome: "selected", optionId } }));
    });
  }
}

/** The first method the agent offers that we know how to use; `undefined` means skip `authenticate`. */
function pickAuthMethod(
  offered: Array<{ id?: unknown }> | undefined,
  preferred: readonly string[],
): string | undefined {
  const ids = new Set((offered ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string"));
  return preferred.find((id) => ids.has(id));
}
