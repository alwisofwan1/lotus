// One long-lived Claude Agent SDK session per thread. Follow-ups are pushed into the same
// input stream (steer), interrupt stops the current turn but keeps the session, and tool
// permission prompts go to the host through `requestPermission`.
//
// Session handling adapted from bb (plugins/provider-claude-code/src/bridge/sdk-session.ts),
// Copyright (c) 2026 Michael Yong, MIT License — see ./LICENSE-bb.

import { LOTUS_DELEGATION_NOTE, lotusNote } from "./delegation-note";
import {
  query,
  type CanUseTool,
  type ModelInfo,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { InputQueue } from "./input-queue";
import { readFileSync, statSync } from "node:fs";

import { IMAGE_MIME_TYPES, type AttachmentParams, type InteractionDecision, type SessionAuth, type ToolPermissionRequest } from "./protocol";

const STDERR_TAIL_MAX_CHARS = 4_000;

// The SDK warns that bypassPermissions shadows canUseTool on every session start. It does for tool
// approvals, but AskUserQuestion still reaches canUseTool in that mode (probed live 2026-11-03), so
// the callback must stay and the warning is noise in the tauri:dev terminal. Only that code is muted.
const SHADOWED_WARNING = "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED";
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((...args: unknown[]) => {
  const options = args[1];
  if (typeof options === "object" && options !== null && (options as { code?: unknown }).code === SHADOWED_WARNING) return;
  emitWarning(...args);
}) as typeof process.emitWarning;

// Variables the parent Claude Code session sets. Passing them on would make the child think it
// is nested inside that session. Lotus does not set CLAUDE_CODE_ENTRYPOINT or hide which client
// it is: the SDK identifies itself.
// BUN_BE_BUN is how the release build runs this bridge (src-tauri/src/chat_runtime/launch.rs);
// `claude` is a Bun-compiled binary too, so it must not inherit it.
const INHERITED_ENV_TO_DROP = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_CLIENT_APP", "BUN_BE_BUN"];

export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || INHERITED_ENV_TO_DROP.includes(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * The child's env for one session's sign-in. Login drops an ANTHROPIC_API_KEY inherited from the
 * shell, so a stray key never bills the user; API key mode hands over the saved one.
 */
export function sessionEnv(env: Record<string, string | undefined>, auth: SessionAuth | undefined): Record<string, string> {
  const result = childEnv(env);
  if (auth?.mode === "login") {
    delete result.ANTHROPIC_API_KEY;
    if (auth.configDir) result.CLAUDE_CONFIG_DIR = auth.configDir;
  }
  if (auth?.mode === "apiKey") result.ANTHROPIC_API_KEY = auth.apiKey;
  return result;
}

/** Claude's model list for this env's sign-in. Starts a CLI that never gets a message. */
export async function listModels(claudePath: string, env: Record<string, string>): Promise<ModelInfo[]> {
  const idle = new InputQueue<SDKUserMessage>();
  const q = query({ prompt: idle, options: { pathToClaudeCodeExecutable: claudePath, env, cwd: process.cwd() } });
  try {
    return await q.supportedModels();
  } finally {
    idle.close("model list read");
    q.close();
  }
}

/**
 * What `/` offers in a folder: every command, plus which of them are skills. Same settings as a
 * session, so the list matches what the session can run. No message is sent.
 */
export async function listCommands(claudePath: string, env: Record<string, string>, cwd: string) {
  const idle = new InputQueue<SDKUserMessage>();
  const q = query({
    prompt: idle,
    options: { pathToClaudeCodeExecutable: claudePath, env, cwd, settingSources: ["user", "project", "local"] },
  });
  try {
    const commands = await q.supportedCommands();
    const { skills } = await q.reloadSkills();
    return {
      commands: commands.map(({ name, description, argumentHint, builtin }) => ({ name, description, argumentHint, builtin })),
      skillNames: skills.map((s) => s.name),
    };
  } finally {
    idle.close("command list read");
    q.close();
  }
}

/** `undefined` is how the SDK spells Claude's own default. */
export function sdkModel(model: string | undefined): string | undefined {
  return model === "default" ? undefined : model;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** A level the SDK takes; anything else (a Codex-only value, a typo) leaves Claude on its default. */
export function isEffort(effort: string | undefined): effort is (typeof EFFORTS)[number] {
  return (EFFORTS as readonly string[]).includes(effort ?? "");
}

/**
 * MCP tools reach Claude deferred: a bare name, no description. Seen live 2026-11-05: asked for
 * "GPT Terra" and Haiku, the lead used its own Agent tool and said GPT was not available.
 */
export const DELEGATION_NOTE = [
  LOTUS_DELEGATION_NOTE,
  "Your built-in Agent tool runs Claude models only; keep it for quick lookups. If the tools are",
  "deferred, load them with ToolSearch first.",
].join(" ");

/**
 * The other Lotus build's MCP server refuses every call ("profile mismatch"), but Claude cannot
 * tell the two apart: seen live 2026-11-05, a dev chat's lead picked `mcp__lotus__lotus_chat_delegate`
 * first and failed. Hidden here, like `otherLotusOff` does for Codex.
 */
export function otherLotusHidden(profileKey: string | undefined): { disallowedTools: string[] } | null {
  const other = profileKey === "lotus" ? "lotus-dev" : profileKey === "lotus-dev" ? "lotus" : null;
  return other ? { disallowedTools: [`mcp__${other}__*`] } : null;
}

type ContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

/**
 * A user message's content. Images go in as pictures, so Claude sees them without a tool call;
 * any other file goes as a line with its path, which Claude opens with Read (bb does the same).
 */
export function userContent(
  text: string,
  attachments: readonly AttachmentParams[],
  readFile: (path: string) => Buffer = readFileSync,
): SDKUserMessage["message"]["content"] {
  if (attachments.length === 0) return text;
  const blocks: ContentBlock[] = [];
  for (const attachment of attachments) {
    const media = IMAGE_MIME_TYPES.find((type) => type === attachment.mimeType);
    if (attachment.kind === "image" && media) {
      blocks.push({ type: "image", source: { type: "base64", media_type: media, data: readFile(attachment.path).toString("base64") } });
    } else {
      const details = [attachment.mimeType, attachment.sizeBytes === null ? null : `${attachment.sizeBytes} bytes`].filter(Boolean);
      blocks.push({
        type: "text",
        text: `[Attached file ${attachment.name}${details.length ? ` (${details.join(", ")})` : ""}. It is on disk at ${attachment.path} — use the Read tool to view it.]`,
      });
    }
  }
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

/**
 * Read rules for what a message names outside `cwd` — a backticked absolute path (an `@` pick) or an
 * attached file — so Claude reads it without asking. A file gets its own rule, a folder all under it;
 * edits there still ask. Checked 2026-11-04 (plans/chat-mention-outside-folder/PLAN.md): set
 * mid-session with `applyFlagSettings`, the rule lets Read through, a sibling file still asks, and a
 * Write still asks even in acceptEdits.
 */
export function outsideReadRules(
  text: string,
  attachments: readonly Pick<AttachmentParams, "kind" | "path">[],
  cwd: string,
  isDir: (path: string) => boolean | null = statDir,
): string[] {
  const root = `${cwd.replace(/\/+$/, "")}/`;
  const named = [...text.matchAll(/`(\/[^`\n]+)`/g)].map((m) => m[1]);
  const attached = attachments.filter((a) => a.kind !== "image").map((a) => a.path);
  return [...named, ...attached].flatMap((raw) => {
    const path = raw.replace(/\/+$/, "");
    // Inside the folder needs nothing; `( ) *` would change what the rule means, so those ask.
    if (!path || `${path}/`.startsWith(root) || /[()*]/.test(path)) return [];
    const dir = isDir(path);
    return dir === null ? [] : [dir ? `Read(/${path}/**)` : `Read(/${path})`];
  });
}

/** null when the path is not there. */
function statDir(path: string): boolean | null {
  try {
    return statSync(path).isDirectory();
  } catch {
    return null;
  }
}

export interface ClaudeSessionOptions {
  threadId: string;
  cwd: string;
  claudePath: string;
  env: Record<string, string>;
  model?: string;
  permissionMode: PermissionMode;
  effort?: string;
  resumeSessionId?: string;
  forkAt?: string;
  conciseReplies?: boolean;
  /** A resumed chat's earlier messages that may name outside paths (`outsideReadRules`). */
  priorInputs?: readonly { text: string; attachments: readonly Pick<AttachmentParams, "kind" | "path">[] }[];
  requestPermission: (request: ToolPermissionRequest) => Promise<InteractionDecision>;
  onMessage: (message: SDKMessage) => void;
  onEnded: (error: Error | null) => void;
}

export class ClaudeSession {
  private readonly input = new InputQueue<SDKUserMessage>();
  private readonly abort = new AbortController();
  private q: Query | null = null;
  private sessionId: string | null;
  private stderrTail = "";
  private readonly readRules: Set<string>;
  // An update of the read rules not yet waited for: the next message waits for it.
  private pendingRules: Promise<void> | null = null;

  constructor(private readonly options: ClaudeSessionOptions) {
    this.sessionId = options.resumeSessionId ?? null;
    this.readRules = new Set((options.priorInputs ?? []).flatMap((p) => outsideReadRules(p.text, p.attachments, options.cwd)));
  }

  /** The flag layer's `permissions` is replaced whole, so every rule so far goes each time. */
  private applyReadRules(q: Query): Promise<void> {
    return q.applyFlagSettings({ permissions: { allow: [...this.readRules] } }).then(() => {}, () => {});
  }

  get providerSessionId(): string | null {
    return this.sessionId;
  }

  start(): void {
    const canUseTool: CanUseTool = async (toolName, input, context) => {
      const decision = await this.options.requestPermission({
        threadId: this.options.threadId,
        kind: "tool-permission",
        toolName,
        toolUseId: context.toolUseID ?? null,
        input,
        blockedPath: context.blockedPath ?? null,
      });
      return decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: decision.answers ? { ...input, answers: decision.answers } : input }
        : { behavior: "deny", message: decision.message };
    };

    this.q = query({
      prompt: this.input,
      options: {
        abortController: this.abort,
        cwd: this.options.cwd,
        env: this.options.env,
        pathToClaudeCodeExecutable: this.options.claudePath,
        systemPrompt: { type: "preset", preset: "claude_code", append: lotusNote(this.options.conciseReplies, DELEGATION_NOTE) },
        ...otherLotusHidden(this.options.env.LOTUS_PROFILE_KEY),
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        // Echoes each input when the CLI takes it in, so a steer is placed where it landed.
        extraArgs: { "replay-user-messages": null },
        permissionMode: this.options.permissionMode,
        canUseTool,
        stderr: (chunk) => {
          this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
        },
        ...(sdkModel(this.options.model) ? { model: sdkModel(this.options.model) } : {}),
        ...(isEffort(this.options.effort) ? { effort: this.options.effort } : {}),
        ...(this.options.resumeSessionId ? { resume: this.options.resumeSessionId } : {}),
        // A fork: a new session holding the chain up to `forkAt`; the original stays as it was.
        ...(this.options.resumeSessionId && this.options.forkAt ? { forkSession: true, resumeSessionAt: this.options.forkAt } : {}),
      },
    });
    // A resumed chat's earlier messages named these; the first message waits for them.
    if (this.readRules.size > 0) this.pendingRules = this.applyReadRules(this.q);
    void this.consume(this.q);
  }

  // Resolves when the SDK has taken the message — the moment a turn (or steer) is accepted.
  // `uuid` comes back on the echo (`isReplay`) when the CLI takes the message in.
  async send(text: string, uuid: string, attachments: readonly AttachmentParams[] = []): Promise<void> {
    const fresh = outsideReadRules(text, attachments, this.options.cwd).filter((rule) => !this.readRules.has(rule));
    for (const rule of fresh) this.readRules.add(rule);
    if (fresh.length > 0 && this.q) this.pendingRules = this.applyReadRules(this.q);
    if (this.pendingRules) {
      // A failed or slow update only means Claude asks, so it never holds the message back for long.
      await Promise.race([this.pendingRules, new Promise((resolve) => setTimeout(resolve, 3000))]);
      this.pendingRules = null;
    }
    return this.input.push({
      type: "user",
      message: { role: "user", content: userContent(text, attachments) },
      parent_tool_use_id: null,
      uuid,
    } as SDKUserMessage);
  }

  /** Applies from the next message; a reply already running keeps its model. */
  async setModel(model: string): Promise<void> {
    if (!this.q) throw new Error("the chat session has ended");
    await this.q.setModel(sdkModel(model));
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  stop(): void {
    this.input.close("session stopped");
    this.abort.abort();
    this.q?.close();
    this.q = null;
  }

  private async consume(q: Query): Promise<void> {
    let failure: Error | null = null;
    try {
      for await (const message of q) {
        const id = (message as { session_id?: string }).session_id?.trim();
        if (id) this.sessionId = id;
        this.options.onMessage(message);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const tail = this.stderrTail.trim();
      failure = new Error(tail && !text.includes(tail) ? `${text}\n\nclaude stderr:\n${tail}` : text);
    } finally {
      this.input.close("stream ended");
      this.q = null;
      this.options.onEnded(failure);
    }
  }
}
