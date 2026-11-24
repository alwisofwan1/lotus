// One Agent Client Protocol process per thread (plans/chat-acp-runners/PLAN.md). JSON-RPC over
// stdio, no PTY, the same transport as Codex (`AppServer`). The agents are the `acp` rows of
// `src/agents.json` (Antigravity, Cursor); another is one more row, if its probe shows the same handshake.
//
// Probed against agy 1.5.9 (2026-11-19): `initialize` → `session/new` needs no `authenticate`
// once `agy` is signed in; `session/new` returns `configOptions` for `model`, `thought_level`
// and `mode`, which `session/set_config_option` changes mid-session; `session/prompt` stays open
// for the whole turn and answers `{stopReason, usage}`.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { AppServer } from "./codex-session";
import { lotusNote } from "./delegation-note";
import type { AcpPermission } from "../../src/modules/chat/providers/acp/translate";
import type { AcpAgent, PermissionMode } from "../../src/modules/chat/providers/acp/agents";
import { IMAGE_MIME_TYPES, type AttachmentParams, type InteractionDecision, type ToolPermissionRequest } from "./protocol";

export type { AcpAgent } from "../../src/modules/chat/providers/acp/agents";

const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

interface ConfigOption {
  id: string;
  currentValue?: string;
  options?: Array<{ value: string; name: string; description?: string }>;
}

function option(configOptions: unknown, id: string): ConfigOption | undefined {
  return (Array.isArray(configOptions) ? (configOptions as ConfigOption[]) : []).find((o) => o.id === id);
}

function signInError(agent: AcpAgent, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return /auth/i.test(message) ? new Error(agent.notSignedIn) : error instanceof Error ? error : new Error(message);
}

/**
 * This app's own Lotus MCP server, as ACP's `mcpServers` entry: the sidecar Lotus registers in
 * `~/.claude.json` under its profile key ("lotus" or "lotus-dev"). The thread id and profile key go
 * in its `env`, as for Codex (`lotusMcpConfig`): the sidecar needs both to know which chat delegates
 * and which app it serves. None when this app has not registered one.
 */
export function lotusMcpServers(claudeJson: unknown, env: Record<string, string | undefined>): Array<Record<string, unknown>> {
  const key = env.LOTUS_PROFILE_KEY;
  const servers = (claudeJson as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> } | null)?.mcpServers;
  const entry = key ? servers?.[key] : undefined;
  if (!key || typeof entry?.command !== "string") return [];
  const vars = { LOTUS_PROFILE_KEY: key, LOTUS_CHAT_THREAD_ID: env.LOTUS_CHAT_THREAD_ID };
  return [
    {
      name: key,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: Object.entries(vars).flatMap(([name, value]) => (value ? [{ name, value }] : [])),
    },
  ];
}

async function readLotusMcpServers(env: Record<string, string | undefined>): Promise<Array<Record<string, unknown>>> {
  try {
    return lotusMcpServers(JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")), env);
  } catch {
    return [];
  }
}

type Handlers = ConstructorParameters<typeof AppServer>[3];
type Opened = { sessionId?: string; configOptions?: unknown; models?: { availableModels?: Array<{ modelId: string; name: string }>; currentModelId?: string } };

/** An agent process past `initialize` and its first `session/new`, waiting for a chat. */
interface Warm {
  server: AppServer;
  first: Opened;
  /** Hands the process's messages to its new owner. */
  use: (handlers: Handlers) => void;
  /** Also sees every notification, whoever owns the process. */
  taps: Set<(message: { method: string; params: unknown }) => void>;
}

// A process's FIRST `session/new` is most of a chat's start (agy 1.5.9, 2026-11-19: ~1.4 s of
// ~1.5 s); a later one on the same process took ~15 ms, in any cwd, with MCP servers. So one spare
// is kept booted. It holds ~180 MB, so it goes after 10 idle minutes.
const SPARE_IDLE_MS = 10 * 60_000;
let spare: { key: string; warm: Promise<Warm>; timer: ReturnType<typeof setTimeout> } | null = null;

const spareKey = (agent: AcpAgent, path: string) => `${agent.id}\0${path}`;

async function boot(agent: AcpAgent, path: string, env: Record<string, string>, onIdleExit: () => void): Promise<Warm> {
  const taps = new Set<(message: { method: string; params: unknown }) => void>();
  let handlers: Handlers = {
    onNotification: () => {},
    onRequest: async (method) => {
      throw new Error(`${method} is not supported`);
    },
    onExit: onIdleExit,
  };
  const server = new AppServer(
    path,
    homedir(),
    env,
    {
      onNotification: (m) => {
        handlers.onNotification(m);
        for (const tap of taps) tap(m);
      },
      onRequest: (m, p) => handlers.onRequest(m, p), onExit: (e) => handlers.onExit(e) },
    agent.args,
  );
  try {
    await server.request("initialize", { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES });
    const first = await server.request<Opened>("session/new", { cwd: homedir(), mcpServers: [] }).catch((error: unknown) => {
      throw signInError(agent, error);
    });
    server.request("session/close", { sessionId: first.sessionId }).catch(() => {});
    return { server, first, taps, use: (next) => (handlers = next) };
  } catch (error) {
    server.close();
    throw error;
  }
}

function dropSpare(): void {
  if (!spare) return;
  clearTimeout(spare.timer);
  spare.warm.then((w) => w.server.close(), () => {});
  spare = null;
}

/** The spare process for this agent, booted if there is none. */
export function warmAcp(agent: AcpAgent, path: string, env: Record<string, string>): Promise<Warm> {
  const key = spareKey(agent, path);
  if (spare?.key !== key) {
    dropSpare();
    const warm: Promise<Warm> = boot(agent, path, env, () => {
      if (spare?.warm === warm) dropSpare();
    });
    warm.catch(() => {
      if (spare?.warm === warm) dropSpare();
    });
    spare = { key, warm, timer: setTimeout(dropSpare, SPARE_IDLE_MS) };
    spare.timer.unref?.();
  }
  return spare.warm;
}

/** Takes the spare for a chat: null when there is none, or it failed to boot. */
async function takeSpare(agent: AcpAgent, path: string): Promise<Warm | null> {
  if (spare?.key !== spareKey(agent, path)) return null;
  const { warm, timer } = spare;
  clearTimeout(timer);
  spare = null;
  return warm.catch(() => null);
}

/** The agent's model list, from the spare's first session: its `model` option, with `thought_level` as efforts. */
export async function listAcpModels(agent: AcpAgent, path: string, env: Record<string, string>): Promise<unknown[]> {
  const session = (await warmAcp(agent, path, env)).first;
  const model = option(session.configOptions, "model");
  const thought = option(session.configOptions, "thought_level");
  const efforts = thought?.options?.map((o) => o.value) ?? [];
  if (model?.options) {
    return model.options.map((m) => ({
      value: m.value,
      displayName: m.name,
      description: m.description ?? null,
      isDefault: m.value === model.currentValue,
      efforts,
      defaultEffort: thought?.currentValue ?? null,
    }));
  }
  const models = session.models;
  return (models?.availableModels ?? []).map((m) => ({ value: m.modelId, displayName: m.name, description: null, isDefault: m.modelId === models?.currentModelId, efforts: [] }));
}

/**
 * What `/` offers in `cwd`: the agent's `available_commands_update` for a session opened there
 * (agy sends it ~170 ms after `session/new`, its own commands and then its skills, unmarked; a
 * project's own skills depend on the cwd). Opened on the spare, so it costs no new process.
 */
export async function listAcpCommands(agent: AcpAgent, path: string, env: Record<string, string>, cwd: string): Promise<Array<{ name: string; description: string }>> {
  const warm = await warmAcp(agent, path, env);
  let sessionId: string | undefined;
  let tap: ((message: { method: string; params: unknown }) => void) | undefined;
  const commands = new Promise<unknown>((resolve) => {
    tap = (message) => {
      const params = message.params as { sessionId?: string; update?: { sessionUpdate?: string; availableCommands?: unknown } } | undefined;
      if (params?.update?.sessionUpdate === "available_commands_update" && (!sessionId || params.sessionId === sessionId)) resolve(params.update.availableCommands);
    };
    warm.taps.add(tap);
    setTimeout(() => resolve([]), 3_000);
  });
  try {
    sessionId = (await warm.server.request<Opened>("session/new", { cwd, mcpServers: [] })).sessionId;
    const list = await commands;
    warm.server.request("session/close", { sessionId }).catch(() => {});
    return (Array.isArray(list) ? list : []).flatMap((c: { name?: unknown; description?: unknown }) =>
      typeof c?.name === "string" ? [{ name: c.name, description: typeof c.description === "string" ? c.description : "" }] : [],
    );
  } finally {
    warm.taps.delete(tap!);
  }
}

/** A message as ACP content blocks: pictures inline, any other file as a link the agent can open. */
export async function acpPrompt(text: string, attachments: readonly AttachmentParams[]): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const a of attachments) {
    if (a.kind === "image" && IMAGE_MIME_TYPES.some((type) => type === a.mimeType)) {
      blocks.push({ type: "image", mimeType: a.mimeType, data: (await readFile(a.path)).toString("base64") });
    } else {
      blocks.push({ type: "resource_link", uri: `file://${a.path}`, name: a.name });
    }
  }
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

export interface AcpSessionOptions {
  threadId: string;
  cwd: string;
  agent: AcpAgent;
  path: string;
  env: Record<string, string>;
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
  resumeSessionId?: string;
  conciseReplies?: boolean;
  describe: (params: Record<string, unknown>) => AcpPermission;
  requestPermission: (request: ToolPermissionRequest) => Promise<InteractionDecision>;
  onMessage: (message: unknown) => void;
  onEnded: (error: Error | null) => void;
}

export class AcpSession {
  private server: AppServer | null = null;
  private sessionId: string | null;
  private ready: Promise<void> | null = null;
  // Turns run one after another: ACP has no steer, so a message sent mid-turn is the next turn.
  private queue: Promise<void> = Promise.resolve();
  private running = false;
  // Model and effort picked since the last turn; sent before the next prompt.
  private pending: { model?: string; effort?: string };
  private started = false;
  // An agent with no system-prompt hook (Cursor) gets Lotus's note in front of its first message
  // instead. Seen 2026-11-20: without it, Cursor delegated with its own Task tool, not Lotus's.
  private noteDue: boolean;

  constructor(private readonly options: AcpSessionOptions) {
    this.sessionId = options.resumeSessionId ?? null;
    this.pending = { model: options.model === "default" ? undefined : options.model, effort: options.effort };
    this.noteDue = !options.agent.systemPromptMeta && !options.resumeSessionId;
  }

  get providerSessionId(): string | null {
    return this.sessionId;
  }

  start(): Promise<void> {
    this.ready = this.open().catch((error: Error) => {
      this.server?.close();
      throw error;
    });
    return this.ready;
  }

  private async open(): Promise<void> {
    const { options } = this;
    const handlers: Handlers = {
      onNotification: (message) => options.onMessage(message),
      onRequest: (method, params) => this.answer(method, (params ?? {}) as Record<string, unknown>),
      onExit: (error) => {
        this.server = null;
        if (this.started) options.onEnded(error);
      },
    };
    // The thread id reaches the Lotus sidecar through `mcpServers` env, so a spare booted without it serves any chat.
    const warm = await takeSpare(options.agent, options.path);
    warm?.use(handlers);
    const server = warm?.server ?? new AppServer(options.path, options.cwd, options.env, handlers, options.agent.args);
    this.server = server;
    if (!warm) await server.request("initialize", { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES });
    const params = {
      cwd: options.cwd,
      mcpServers: await readLotusMcpServers(options.env),
      // agy appends this to its system prompt (checked 2026-11-19); without it, agy reached the Lotus app with curl.
      ...(options.agent.systemPromptMeta && { _meta: { [options.agent.systemPromptMeta]: { systemPrompt: { append: lotusNote(options.conciseReplies) } } } }),
    };
    const opened = await (this.sessionId
      ? server.request<Opened>("session/resume", { sessionId: this.sessionId, ...params })
      : server.request<Opened>("session/new", params)
    ).catch((error: unknown) => {
      throw signInError(options.agent, error);
    });
    this.sessionId = opened.sessionId ?? this.sessionId;
    // A mode Lotus asked for and the agent did not take fails the start: running "plan" as "default" would edit files.
    const mode = options.agent.modes[options.permissionMode];
    let config = opened.configOptions;
    if (option(config, "mode")?.currentValue !== mode) config = (await this.config("mode", mode)) ?? config;
    options.onMessage({ method: "lotus/configured", params: { sessionId: this.sessionId, model: this.pending.model ?? option(config, "model")?.currentValue ?? null, cwd: options.cwd } });
    this.started = true;
  }

  private async config(configId: string, value: string): Promise<unknown> {
    const result = await this.server!.request<{ configOptions?: unknown }>("session/set_config_option", { sessionId: this.sessionId, configId, value });
    return result.configOptions;
  }

  private async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== "session/request_permission") throw new Error(`${method} is not supported`);
    const options = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId: string; kind: string }>;
    // "Allow everything": agy has no mode that never asks (its "auto" still does), so Lotus answers for the user.
    const decision: InteractionDecision =
      this.options.permissionMode === "bypassPermissions"
        ? { behavior: "allow" }
        : await this.options.requestPermission({ threadId: this.options.threadId, kind: "tool-permission", ...this.options.describe(params) });
    const kinds = decision.behavior === "allow" ? (decision.remember ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) : ["reject_once", "reject_always"];
    const chosen = kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
    return { outcome: chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" } };
  }

  async send(text: string, uuid: string, attachments: readonly AttachmentParams[] = []): Promise<void> {
    await this.ready;
    if (!this.server || !this.sessionId) throw new Error("the chat session has ended");
    const prompt = await acpPrompt(text, attachments);
    if (this.noteDue) {
      prompt.unshift({ type: "text", text: `<lotus-instructions>\n${lotusNote(this.options.conciseReplies)}\n</lotus-instructions>` });
      this.noteDue = false;
    }
    // Not awaited: the prompt request lasts the whole turn, and the host only waits for acceptance.
    this.queue = this.queue.then(() => this.turn(uuid, prompt));
  }

  private async turn(uuid: string, prompt: Array<Record<string, unknown>>): Promise<void> {
    const server = this.server;
    if (!server) return;
    const { onMessage } = this.options;
    const startedAt = Date.now();
    this.running = true;
    onMessage({ method: "lotus/turnStarted", params: { uuid } });
    try {
      const { model, effort } = this.pending;
      this.pending = {};
      if (model) await this.config("model", model);
      if (effort) await this.config("thought_level", effort).catch(() => {}); // a model without levels keeps its own
      const result = await server.request<{ stopReason?: string; usage?: unknown }>("session/prompt", { sessionId: this.sessionId, prompt });
      onMessage({ method: "lotus/turnEnded", params: { stopReason: result.stopReason ?? null, usage: result.usage ?? null, durationMs: Date.now() - startedAt } });
    } catch (error) {
      onMessage({ method: "lotus/turnEnded", params: { error: error instanceof Error ? error.message : String(error) } });
    } finally {
      this.running = false;
    }
  }

  /** Applies from the next turn. */
  async setModel(model: string, effort?: string): Promise<void> {
    if (model !== "default") this.pending.model = model;
    if (effort) this.pending.effort = effort;
  }

  async interrupt(): Promise<void> {
    if (this.server && this.sessionId && this.running) this.server.notify("session/cancel", { sessionId: this.sessionId });
  }

  stop(): void {
    this.server?.close();
  }
}
