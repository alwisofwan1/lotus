import { spawn, type ChildProcess } from "node:child_process";
import { agentSpawnEnv } from "../../../../../core/agent-env.js";
import { homedir } from "node:os";

import { resolveClaudeConfigDir, trustProjectFolder } from "../../../../../core/claude-trust.js";

import type { PromptAttachment, ProviderBridgeSession, ProviderUsage } from "../../../../../types/provider-bridge.js";
import { claudeContent } from "../prompt-blocks.js";
import { ApprovalHost, type ApprovalAnswer } from "./approval-host.js";
import { buildArgs } from "./args.js";
import { ControlChannel } from "./control.js";
import { ClaudeConversation } from "./conversation.js";
import { approvalAnswerFor } from "./pending.js";
import type { ClaudeMessage } from "./messages.js";

/**
 * One Claude thread over `claude --print --output-format stream-json`, **no SDK**: one process
 * lives across turns. The TUI stays default; this is the `tui: false` mode
 * (`plans/provider-bridge-adoption/PLAN.md` Fase 3).
 */
export interface ClaudeSessionOptions {
  paneId: string;
  cwd: string;
  /** A stop on Claude's own scale: `plan`, `manual`, `acceptEdits`, `bypassPermissions`. */
  permissionMode?: string;
  model?: string;
  effort?: string;
  /** Resume an existing conversation instead of starting one. */
  resumeSessionId?: string;
  /**
   * `CLAUDE_CONFIG_DIR`: which account this cell works as. Absent inherits the host's
   * (a host from an activated shell is already on the right one).
   */
  configDir?: string;
  /** Chat Attachment copies live here, outside `cwd`; Claude reads them without asking, as on the desktop. */
  readableDir?: string;
  /** The binary, so a test can point at a fake. */
  command?: string;
  args?: string[];
  /**
   * Off to skip the approval channel entirely — no MCP server, no socket.
   *
   * For tests, and for callers that want the runner's own `--permission-mode` to decide.
   */
  approvals?: boolean;
}

export class ClaudeStreamSession implements ProviderBridgeSession {
  readonly conversation: ClaudeConversation;
  private readonly child: ChildProcess;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private buffer = "";
  /** Resolves when the turn in flight reports its `result`. */
  private turnDone: (() => void) | undefined;
  /** An operator Stop is on its way: the turn's `result` is a cancel, not a failure. */
  private interrupting = false;
  private readonly approvals: ApprovalHost | undefined;
  /** The answer the operator has not given yet, per request id. */
  private readonly waiting = new Map<string, (answer: ApprovalAnswer) => void>();
  private readonly control: ControlChannel;
  /** The posture this cell is on right now — moved by [`setPermissionMode`], never re-spawned. */
  private mode: string;
  /**
   * What each pending request was asking, kept because answering a **question** needs the
   * tool's original input to write the choice back into (`questions.ts`). The conversation
   * holds the part, which carries only what the operator reads.
   */
  private readonly asked = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  private nextRequest = 0;

  constructor(private readonly opts: ClaudeSessionOptions) {
    this.mode = opts.permissionMode ?? "manual";
    this.conversation = new ClaudeConversation(opts.paneId);
    // `--print` skips the trust dialog, so this cell does not need it — but a **terminal**
    // cell opened in the same folder later does, and it would stop dead at a gate the phone
    // cannot answer. Recording it here means the first headless run clears the way.
    trustProjectFolder({
      configDir: opts.configDir ?? resolveClaudeConfigDir(process.env, homedir()),
      cwd: opts.cwd,
    });
    this.approvals =
      opts.approvals === false
        ? undefined
        : new ApprovalHost({ paneId: opts.paneId, onRequest: (r) => this.onApprovalRequest(r) });
    this.child = spawn(opts.command ?? "claude", opts.args ?? buildArgs(opts, this.approvals?.mcpConfig()), {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: agentSpawnEnv(process.env, {
        LOTUS_PANE_ID: opts.paneId,
        ...(opts.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: opts.configDir }),
      }),
    });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      this.control.abandon("the cell stopped before the runner answered");
      // A process that died mid-turn must not leave `prompt()` waiting for a `result`
      // that can no longer come.
      this.finishTurn();
    });
    if (this.child.stdout === null || this.child.stdin === null) {
      throw new Error("claude: stdio pipes were not created");
    }
    this.control = new ControlChannel((line) => this.child.stdin?.write(line));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
  }

  get alive(): boolean {
    return this.exited === undefined;
  }

  get thread(): string | undefined {
    return this.conversation.sessionId;
  }

  /** The stop this cell is on, as the runner last confirmed it. */
  get permissionMode(): string {
    return this.mode;
  }

  /**
   * Moves the posture **without a restart**, via `control_request`. **The runner decides what
   * the mode means**: imitating it here would reproduce the CLI's classifier, and errors fail
   * permissive.
   */
  async setPermissionMode(mode: string, timeoutMs = 10_000): Promise<void> {
    if (!this.alive) throw new Error("this cell is no longer running");
    const answer = await this.control.request({ subtype: "set_permission_mode", mode }, timeoutMs);
    // The mode the runner says it settled on, not the one we asked for: it is the authority on
    // what it accepted, and a cell reporting a stop it is not actually on is the worst answer here.
    this.mode = typeof answer["mode"] === "string" ? answer["mode"] : mode;
  }

  /**
   * Nothing to hand-shake: the process is running from the constructor and announces itself
   * with `system/init` on the first turn. Kept so the seam has one shape for every bridge.
   */
  async start(): Promise<void> {
    return Promise.resolve();
  }

  /** One operator ask → one turn. Resolves when the turn **ends**, as ACP's does. */
  async prompt(text: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    if (!this.alive) {
      this.conversation.openTurn(text);
      this.conversation.apply({ type: "result", is_error: true, stop_reason: "error" });
      return;
    }
    this.conversation.openTurn(text);
    const done = new Promise<void>((resolve) => {
      this.turnDone = resolve;
    });
    this.child.stdin?.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: claudeContent(text, attachments) } })}\n`,
    );
    await done;
  }

  /** Control `interrupt` keeps the cell alive (probed 2026-11-24); `SIGINT` under `--print` kills it, so it is only the fallback for a runner too old to answer. */
  async interrupt(timeoutMs = 3_000): Promise<void> {
    if (!this.alive) return;
    this.interrupting = this.turnDone !== undefined;
    try {
      await this.control.request({ subtype: "interrupt" }, timeoutMs);
    } catch {
      if (this.alive) this.child.kill("SIGINT");
    }
  }

  /**
   * Answers a pending approval by digit, releasing the runner. Returns whether one was waiting,
   * so a route can tell "answered" from "nothing to answer".
   */
  decide(key: string): boolean {
    const requestId = this.conversation.pendingRequestId();
    if (requestId === undefined) return false;
    const option = this.conversation.decide(requestId, key);
    const release = this.waiting.get(requestId);
    const asked = this.asked.get(requestId);
    if (option === undefined || release === undefined) return false;
    this.waiting.delete(requestId);
    this.asked.delete(requestId);
    release(approvalAnswerFor(asked ?? { toolName: "", input: {} }, option));
    return true;
  }

  /** The plan window the runner last volunteered, straight off its own stream. */
  usage(): ProviderUsage | undefined {
    return this.conversation.rateLimit;
  }

  close(): void {
    // Release anything still waiting first: a closed session must not leave the runner's
    // MCP server blocked on a socket that is about to disappear.
    for (const [, release] of this.waiting) {
      release({ behavior: "deny", message: "The cell was closed." });
    }
    this.waiting.clear();
    this.asked.clear();
    this.approvals?.close();
    this.child.stdin?.end();
    this.child.kill();
  }

  /** The runner is asking. Held open until [`decide`] answers, or the cell closes. */
  private onApprovalRequest(request: {
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
  }): Promise<ApprovalAnswer> {
    const requestId = `perm-${this.nextRequest++}`;
    this.conversation.requestPermission(requestId, request);
    this.asked.set(requestId, { toolName: request.toolName, input: request.input });
    return new Promise<ApprovalAnswer>((resolve) => this.waiting.set(requestId, resolve));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === "") continue;
      let message: ClaudeMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) continue;
        const type = (parsed as { type?: unknown }).type;
        if (typeof type !== "string") continue;
        message = { ...(parsed as object), type } as ClaudeMessage;
      } catch {
        // Not protocol traffic. The CLI prints warnings on this channel in some builds, and
        // a reader that threw on one would end the cell over a notice.
        continue;
      }
      // The control channel shares this stdout with the conversation. A response that reached
      // the timeline would draw as an `unknown` part — protocol chatter rendered to the
      // operator as a step the agent took.
      if (this.control.settle(message)) continue;
      if (message.type === "result" && this.interrupting) {
        // The runner reports a stop as an error; the operator asked for it, so it is a cancel.
        message = { ...message, is_error: false, stop_reason: "cancelled" };
        this.interrupting = false;
      }
      this.conversation.apply(message);
      if (message.type === "result") this.finishTurn();
    }
  }

  private finishTurn(): void {
    const done = this.turnDone;
    this.turnDone = undefined;
    done?.();
  }
}
