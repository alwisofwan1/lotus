// One `codex app-server` process per Codex thread (#286). JSON-RPC over stdio, no PTY: Lotus
// starts or resumes a Codex thread, sends turns, steers the running one, and answers Codex's
// approval requests through the host. Every server message goes to `onMessage` for the
// CodexTranslator; the session's own sends go there too, as `lotus/*` messages, so the translator
// knows which input opened a turn and which one steered it.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { lotusNote, subAgentNote } from "./delegation-note";
import { codexPolicy, type CodexPermission } from "../../src/modules/chat/providers/codex/translate";
import { IMAGE_MIME_TYPES, type AttachmentParams, type InteractionDecision, type ToolPermissionRequest } from "./protocol";

const STDERR_TAIL_MAX_CHARS = 4_000;
const CLIENT_INFO = { name: "lotus", title: "Lotus", version: "0.1.0" };

export const CODEX_NOT_INSTALLED = "Codex isn’t installed. Install it with `npm install -g @openai/codex`, then send again.";
export const CODEX_NOT_SIGNED_IN = "Codex isn’t signed in. Run `codex login` in a terminal, then send again.";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A running `codex app-server` (or any stdio JSON-RPC agent, e.g. `agy acp`): requests out, notifications and server requests in. */
// Every agent process this bridge started. cursor-agent with MCP servers ignores stdin EOF, so a
// bridge that exits without killing it leaves it (and its MCP sidecars) orphaned under launchd.
const live = new Set<ChildProcessWithoutNullStreams>();

/** SIGTERM to every agent process still alive, warm spare included. Synchronous: safe before `process.exit`. */
export function killAllAgentProcesses(): void {
  for (const child of live) child.kill("SIGTERM");
}

export class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  private exited: Error | null = null;
  private readonly label: string;

  constructor(
    codexPath: string,
    cwd: string,
    env: Record<string, string>,
    private readonly handlers: {
      onNotification: (message: { method: string; params: unknown }) => void;
      onRequest: (method: string, params: unknown) => Promise<unknown>;
      onExit: (error: Error | null) => void;
    },
    args: readonly string[] = ["app-server"],
  ) {
    this.label = `${codexPath.split(/[\\/]/).pop()} ${args.join(" ")}`;
    this.child = spawn(codexPath, [...args], { cwd, env: env as NodeJS.ProcessEnv, stdio: "pipe" });
    live.add(this.child);
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_CHARS);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    this.child.on("error", (error) => this.finish(error));
    this.child.on("exit", (code, signal) => {
      live.delete(this.child);
      const tail = this.stderrTail.trim();
      this.finish(code === 0 || signal === "SIGTERM" ? null : new Error(`${this.label} exited (${code ?? signal})${tail ? `\n\nstderr:\n${tail}` : ""}`));
    });
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Starts the connection the way every client must: `initialize`, then `initialized`. */
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: CLIENT_INFO });
    this.notify("initialized");
  }

  close(): void {
    this.child.kill("SIGTERM");
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private onLine(line: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      const id = msg.id;
      this.handlers.onRequest(msg.method, msg.params).then(
        (result) => this.write({ id, result }),
        (error: Error) => this.write({ id, error: { code: -32603, message: error.message } }),
      );
    } else if (msg.method) {
      this.handlers.onNotification({ method: msg.method, params: msg.params });
    } else if (typeof msg.id === "number") {
      const waiting = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) waiting?.reject(new Error(msg.error.message ?? `${this.label} error`));
      else waiting?.resolve(msg.result);
    }
  }

  private finish(error: Error | null): void {
    if (this.exited) return;
    this.exited = error ?? new Error(`${this.label} stopped`);
    for (const waiting of this.pending.values()) waiting.reject(this.exited);
    this.pending.clear();
    this.handlers.onExit(error);
  }
}

/** A Codex message's input: pictures by path, any other file as a line Codex can open. */
export function codexInput(text: string, attachments: readonly AttachmentParams[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image" && IMAGE_MIME_TYPES.some((type) => type === attachment.mimeType)) {
      input.push({ type: "localImage", path: attachment.path });
    } else {
      input.push({ type: "text", text: `[Attached file ${attachment.name}. It is on disk at ${attachment.path} — read it there.]`, text_elements: [] });
    }
  }
  if (text.trim()) input.push({ type: "text", text, text_elements: [] });
  return input;
}

export interface CodexSkillRef {
  name: string;
  path: string;
}

/**
 * A message that starts with `/name` of a known skill sends the skill as structured input: Codex
 * then always loads it (plain `/name` text works only when the model decides to). Unknown names
 * stay plain text.
 */
export function codexTurnInput(
  text: string,
  attachments: readonly AttachmentParams[],
  skills: readonly CodexSkillRef[],
): Array<Record<string, unknown>> {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const skill = m ? skills.find((s) => s.name === m[1]) : undefined;
  if (!m || !skill) return codexInput(text, attachments);
  return [...codexInput(m[2] ?? "", attachments), { type: "skill", name: skill.name, path: skill.path }];
}

async function readSkills(server: AppServer, cwd: string): Promise<Array<Record<string, unknown>>> {
  const { data } = await server.request<{ data: Array<{ skills?: Array<Record<string, unknown>> }> }>("skills/list", { cwds: [cwd] });
  return data.flatMap((entry) => entry.skills ?? []);
}

/** The skills Codex offers in a folder, from a short-lived app-server. */
export async function listCodexSkills(codexPath: string, env: Record<string, string>, cwd: string): Promise<unknown[]> {
  const server = new AppServer(codexPath, cwd, env, { onNotification: () => {}, onRequest: async () => ({}), onExit: () => {} });
  try {
    await server.initialize();
    return (await readSkills(server, cwd)).map(({ name, description, shortDescription, path, scope, enabled }) => ({
      name,
      description,
      shortDescription,
      path,
      scope,
      enabled,
    }));
  } finally {
    server.close();
  }
}

/** Codex's model list, from a short-lived app-server. Hidden models are left out. */
export async function listCodexModels(codexPath: string, env: Record<string, string>): Promise<unknown[]> {
  const server = new AppServer(codexPath, process.cwd(), env, {
    onNotification: () => {},
    onRequest: async () => ({}),
    onExit: () => {},
  });
  try {
    await server.initialize();
    const { data } = await server.request<{ data: Array<Record<string, unknown>> }>("model/list", { limit: 100 });
    return data
      .filter((m) => m.hidden !== true)
      .map((m) => ({
        value: m.id,
        displayName: m.displayName,
        description: m.description,
        isDefault: m.isDefault === true,
        efforts: (m.supportedReasoningEfforts as Array<{ reasoningEffort: string }> | undefined)?.map((e) => e.reasoningEffort) ?? [],
        defaultEffort: m.defaultReasoningEffort ?? null,
      }));
  } finally {
    server.close();
  }
}

export interface CodexSessionOptions {
  threadId: string;
  cwd: string;
  codexPath: string;
  env: Record<string, string>;
  model?: string;
  effort?: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  resumeSessionId?: string;
  forkAt?: string;
  conciseReplies?: boolean;
  /** A chat Lotus delegated; it gets the sub-agent note instead of the delegation note. */
  subAgent?: "worker" | "verifier";
  describe: (method: string, params: Record<string, unknown>) => CodexPermission | null;
  requestPermission: (request: ToolPermissionRequest) => Promise<InteractionDecision>;
  onMessage: (message: unknown) => void;
  onEnded: (error: Error | null) => void;
}

/**
 * `~/.codex/config.toml` is shared, so a machine with both Lotus apps lists both `lotus` and
 * `lotus-dev`. Codex then picks either one, and the other app's chats are not there: checked live
 * 2026-11-02, the first `lotus_chat_read` went to the wrong app and got "no chat". This turns the
 * other app's server off for this thread only — when it is configured: turning off one that is
 * not fails the whole thread with "invalid transport in `mcp_servers.<name>`" (checked 2026-11-04),
 * which is every Codex chat in a release app on a machine that never ran the dev one.
 */
export function otherLotusOff(profileKey: string | undefined, configured: readonly string[]): Record<string, boolean> | null {
  const other = profileKey === "lotus" ? "lotus-dev" : profileKey === "lotus-dev" ? "lotus" : null;
  return other && configured.includes(other) ? { [`mcp_servers.${other}.enabled`]: false } : null;
}

/**
 * Codex starts MCP servers with a filtered env, so `LOTUS_CHAT_THREAD_ID` on app-server never
 * reached the sidecar: seen live 2026-11-05, a Codex chat's `lotus_chat_delegate` said "no
 * LOTUS_CHAT_THREAD_ID". The thread id goes into this app's own server's `env` instead.
 */
export function lotusMcpConfig(
  env: Record<string, string | undefined>,
  configured: readonly string[],
): Record<string, unknown> | null {
  const own = env.LOTUS_PROFILE_KEY;
  const threadId = env.LOTUS_CHAT_THREAD_ID;
  const config = {
    ...otherLotusOff(own, configured),
    ...(own && threadId && configured.includes(own) ? { [`mcp_servers.${own}.env.LOTUS_CHAT_THREAD_ID`]: threadId } : {}),
  };
  return Object.keys(config).length ? config : null;
}

interface UserCodexConfig {
  mcpServers: string[];
  developerInstructions: string | null;
}

/** What the user's Codex config sets in `cwd` that Lotus must keep; nothing when it cannot be read. */
async function userCodexConfig(server: AppServer, cwd: string): Promise<UserCodexConfig> {
  try {
    type Config = { mcp_servers?: Record<string, unknown>; developer_instructions?: string | null };
    const { config } = await server.request<{ config: Config }>("config/read", { cwd });
    return { mcpServers: Object.keys(config.mcp_servers ?? {}), developerInstructions: config.developer_instructions?.trim() || null };
  } catch {
    return { mcpServers: [], developerInstructions: null };
  }
}

/** The thread's `developerInstructions` replace the config's, so the user's own come first, then Lotus's. */
export function withUserInstructions(user: string | null, lotus: string): string {
  return user ? `${user}\n\n${lotus}` : lotus;
}

export class CodexSession {
  private server: AppServer | null = null;
  private codexThreadId: string | null;
  private forkAt: string | undefined;
  private activeTurn: string | null = null;
  private model: string | undefined;
  private effort: string | undefined;
  private ready: Promise<void> | null = null;
  private account: unknown = null;
  // A session that never started reports its failure from `start()`, not as an ended session.
  private started = false;

  constructor(private readonly options: CodexSessionOptions) {
    this.codexThreadId = options.resumeSessionId ?? null;
    this.forkAt = options.forkAt;
    this.model = options.model === "default" ? undefined : options.model;
    this.effort = options.effort;
  }

  get providerSessionId(): string | null {
    return this.codexThreadId;
  }

  /** Resolves once Codex has the thread; rejects (and ends the session) when it cannot start. */
  start(): Promise<void> {
    this.ready = this.open().catch((error: Error) => {
      this.server?.close();
      throw error;
    });
    return this.ready;
  }

  private async open(): Promise<void> {
    const { options } = this;
    const server = new AppServer(options.codexPath, options.cwd, options.env, {
      onNotification: (message) => {
        const params = (message.params ?? {}) as Record<string, unknown>;
        if (message.method === "turn/started") this.activeTurn = ((params.turn as Record<string, unknown>)?.id as string) ?? this.activeTurn;
        if (message.method === "turn/completed") this.activeTurn = null;
        options.onMessage(message);
      },
      onRequest: (method, params) => this.answer(method, (params ?? {}) as Record<string, unknown>),
      onExit: (error) => {
        this.server = null;
        if (this.started) options.onEnded(error);
      },
    });
    this.server = server;
    await server.initialize();
    const { account, requiresOpenaiAuth } = await server.request<{ account: unknown; requiresOpenaiAuth: boolean }>("account/read", {});
    if (!account && requiresOpenaiAuth) throw new Error(CODEX_NOT_SIGNED_IN);
    this.account = account;
    await this.openThread(server, this.codexThreadId);
    this.started = true;
  }

  /** Resumes `resumeId`, or starts a fresh Codex thread; either way the session follows it. */
  private async openThread(server: AppServer, resumeId: string | null): Promise<void> {
    const { options } = this;
    const user = await userCodexConfig(server, options.cwd);
    const params = {
      cwd: options.cwd,
      ...codexPolicy(options.permissionMode),
      ...(this.model ? { model: this.model } : {}),
      config: lotusMcpConfig(options.env, user.mcpServers),
      developerInstructions: withUserInstructions(user.developerInstructions, lotusNote(options.conciseReplies, subAgentNote(options.subAgent))),
    };
    type Opened = { thread: { id: string }; model: string };
    // A fork forks once: a `/clear` later in the session starts fresh, as anywhere else.
    const forkAt = resumeId ? this.forkAt : undefined;
    this.forkAt = undefined;
    const started = forkAt
      ? await server.request<Opened>("thread/fork", { threadId: resumeId, lastTurnId: forkAt, ...params })
      : resumeId
        ? await server.request<Opened>("thread/resume", { threadId: resumeId, ...params })
        : await server.request<Opened>("thread/start", params);
    this.codexThreadId = started.thread.id;
    options.onMessage({ method: "lotus/configured", params: { threadId: started.thread.id, model: started.model, cwd: options.cwd, account: this.account } });
  }

  /**
   * `/clear` and `/compact`, which app-server has as methods, not as text. `/compact` runs as a real
   * Codex turn. `/clear` moves to a new Codex thread (the old one stays on disk), wrapped in a turn of
   * its own so the message resolves like any other.
   */
  private async command(server: AppServer, name: "clear" | "compact", uuid: string): Promise<void> {
    if (this.activeTurn) throw new Error(`Wait for the reply to finish, then send /${name}.`);
    this.options.onMessage({ method: "lotus/turnSent", params: { uuid } });
    if (name === "compact") {
      await server.request("thread/compact/start", { threadId: this.codexThreadId });
      return;
    }
    const turn = { id: `clear-${uuid}` };
    this.options.onMessage({ method: "turn/started", params: { turn } });
    try {
      await this.openThread(server, null);
      this.options.onMessage({ method: "turn/completed", params: { turn: { ...turn, status: "completed" } } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onMessage({ method: "turn/completed", params: { turn: { ...turn, status: "failed", error: { message } } } });
    }
  }

  private async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    const notice = this.options.describe(method, params);
    // An elicitation answers with `action`, not `decision`.
    const elicitation = method === "mcpServer/elicitation/request";
    // Anything Lotus cannot show (other elicitations, extra permissions) is declined, never granted blind.
    if (!notice) return method === "item/permissions/requestApproval" ? { permissions: {} } : elicitation ? { action: "decline" } : { decision: "decline" };
    const decision = await this.options.requestPermission({ threadId: this.options.threadId, kind: "tool-permission", ...notice });
    const allow = decision.behavior === "allow";
    // `persist: "session"` makes Codex skip asking again for this tool; checked live 2026-11-02 (2 calls, 1 ask).
    if (elicitation) return allow ? { action: "accept", content: {}, _meta: decision.behavior === "allow" && decision.remember ?{ persist: "session" } : null } : { action: "decline" };
    return { decision: allow ? "accept" : "decline" };
  }

  // A message while a turn runs steers it; otherwise it starts the next turn.
  async send(text: string, uuid: string, attachments: readonly AttachmentParams[] = []): Promise<void> {
    await this.ready;
    const server = this.server;
    if (!server || !this.codexThreadId) throw new Error("the chat session has ended");
    const command = /^\/(clear|compact)$/.exec(text.trim())?.[1] as "clear" | "compact" | undefined;
    if (command && attachments.length === 0) return this.command(server, command, uuid);
    const input = codexTurnInput(text, attachments, /^\s*\/\S/.test(text) ? await this.skills(server) : []);
    if (this.activeTurn) {
      try {
        await server.request("turn/steer", { threadId: this.codexThreadId, expectedTurnId: this.activeTurn, input, clientUserMessageId: uuid });
        this.options.onMessage({ method: "lotus/steered", params: { uuid } });
        return;
      } catch {
        // The turn ended between the check and the steer: start a new one instead.
      }
    }
    this.options.onMessage({ method: "lotus/turnSent", params: { uuid } });
    const { turn } = await server.request<{ turn: { id: string } }>("turn/start", {
      threadId: this.codexThreadId,
      input,
      clientUserMessageId: uuid,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    });
    this.activeTurn ??= turn.id;
  }

  private skillList: Promise<CodexSkillRef[]> | null = null;

  // Read once per session, on the first `/` message. A failed read sends the text as is.
  private skills(server: AppServer): Promise<CodexSkillRef[]> {
    this.skillList ??= readSkills(server, this.options.cwd)
      .then((skills) => skills.filter((s) => s.enabled !== false).map((s) => ({ name: String(s.name), path: String(s.path) })))
      .catch(() => {
        this.skillList = null;
        return [];
      });
    return this.skillList;
  }

  /** Applies from the next turn: Codex takes model and effort per `turn/start`. */
  async setModel(model: string, effort?: string): Promise<void> {
    this.model = model === "default" ? undefined : model;
    if (effort) this.effort = effort;
  }

  async interrupt(): Promise<void> {
    if (this.server && this.codexThreadId && this.activeTurn) {
      await this.server.request("turn/interrupt", { threadId: this.codexThreadId, turnId: this.activeTurn });
    }
  }

  stop(): void {
    this.server?.close();
  }
}
