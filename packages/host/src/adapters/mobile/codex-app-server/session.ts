import { spawn, type ChildProcess } from "node:child_process";
import { agentSpawnEnv } from "../../../core/agent-env.js";

import { JsonRpcError, JsonRpcStdio, type JsonRpcServerRequest } from "../structured/jsonrpc-stdio.js";
import { NativeConversation } from "./native-conversation.js";
import type { PromptAttachment } from "../../../types/provider-bridge.js";
import { codexInput } from "../structured/bridges/prompt-blocks.js";

/**
 * One Codex thread over `codex app-server`, no terminal. `initialized` is a required
 * notification; `sandbox` is a **string** (the object form is rejected). Approvals are server
 * requests answered through [`decide`]; Codex waits.
 */
export interface CodexSessionOptions {
  paneId: string;
  cwd: string;
  /** `never` runs unattended; `on-request` routes approvals to the phone. */
  approvalPolicy: "never" | "on-request" | "untrusted";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  model?: string;
  effort?: string;
  /** Continue this thread (`thread/resume`) instead of starting one. */
  resumeThreadId?: string;
  /** The binary, so a test can point at a fake. */
  command?: string;
  args?: string[];
}

interface OpenApproval {
  resolve: (decision: string) => void;
}

export class CodexAppServerSession {
  readonly conversation: NativeConversation;
  private readonly child: ChildProcess;
  private readonly rpc: JsonRpcStdio;
  private threadId: string | undefined;
  private readonly approvals = new Map<string, OpenApproval>();
  private nextApproval = 0;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(private readonly opts: CodexSessionOptions) {
    this.conversation = new NativeConversation(opts.paneId);
    this.child = spawn(opts.command ?? "codex", opts.args ?? ["app-server"], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: agentSpawnEnv(process.env, { LOTUS_PANE_ID: opts.paneId }),
    });
    this.child.on("exit", (code, signal) => { this.exited = { code, signal }; });
    if (this.child.stdout === null || this.child.stdin === null) {
      throw new Error("codex app-server: stdio pipes were not created");
    }
    this.rpc = new JsonRpcStdio(this.child.stdout, this.child.stdin);
    this.rpc.onNotification((n) => this.conversation.apply(n.method, n.params));
    this.rpc.onServerRequest((req) => this.onServerRequest(req));
  }

  get alive(): boolean {
    return this.exited === undefined;
  }

  get thread(): string | undefined {
    return this.threadId;
  }

  async start(): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: { name: "lotus-pocket-host", title: "Lotus", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.rpc.notify("initialized");
    const posture = {
      cwd: this.opts.cwd,
      approvalPolicy: this.opts.approvalPolicy,
      sandbox: this.opts.sandbox,
      ...(this.opts.model === undefined ? {} : { model: this.opts.model }),
    };
    // Probed 2026-11-20 (codex 0.171): resume keeps the context and replays no old items.
    const resume = this.opts.resumeThreadId;
    const result = (await (resume === undefined
      ? this.rpc.request("thread/start", { ...posture, ephemeral: false })
      : this.rpc.request("thread/resume", { ...posture, threadId: resume, excludeTurns: true }))) as { thread?: { id?: string } };
    if (typeof result.thread?.id !== "string") throw new Error("codex returned no thread id");
    this.threadId = result.thread.id;
  }

  /** One operator ask → one turn. Resolves when Codex has accepted the turn, not when it ends. */
  async prompt(text: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    if (this.threadId === undefined) throw new Error("session not started");
    await this.rpc.request("turn/start", {
      threadId: this.threadId,
      input: attachments.length === 0 ? [{ type: "text", text }] : codexInput(text, attachments),
      ...(this.opts.effort === undefined ? {} : { effort: this.opts.effort }),
    });
  }

  async interrupt(): Promise<void> {
    if (this.threadId === undefined) return;
    const open = [...this.conversation.page().turns].reverse().find((t) => t.endedAt === undefined);
    if (open === undefined) return;
    await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: open.turnId });
  }

  /** The phone's answer to a pending approval, by printed digit. Returns whether one was waiting. */
  decide(key: string): boolean {
    const pending = this.conversation.pendingPermission();
    if (pending === undefined) return false;
    const decision = this.conversation.decide(pending.requestId, key);
    const open = this.approvals.get(pending.requestId);
    if (decision === undefined || open === undefined) return false;
    this.approvals.delete(pending.requestId);
    open.resolve(decision);
    return true;
  }

  close(): void {
    for (const open of this.approvals.values()) open.resolve("decline");
    this.approvals.clear();
    if (this.alive) this.child.kill();
  }

  private onServerRequest(req: JsonRpcServerRequest): Promise<unknown> {
    if (req.method === "item/commandExecution/requestApproval" || req.method === "item/fileChange/requestApproval") {
      const requestId = `a${this.nextApproval++}`;
      const part = this.conversation.requestApproval(req.method, req.params, requestId);
      if (part === undefined) return Promise.resolve({ decision: "decline" });
      return new Promise((resolve) => {
        this.approvals.set(requestId, { resolve: (decision) => resolve({ decision }) });
      });
    }
    // `item/tool/requestUserInput`, elicitations, permissions: not surfaced yet. Refusing is
    // what keeps the turn moving; a hang here would look like a frozen agent on the phone.
    return Promise.reject(new JsonRpcError(-32601, `Lotus does not handle ${req.method}`));
  }
}
