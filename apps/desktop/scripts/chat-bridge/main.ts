// Chat bridge entry point. Reads JSON-RPC requests from stdin, writes responses, notifications
// and its own requests (tool approvals) to stdout. Logs go to stderr only.
//
// Each thread's SDK messages are translated into provider-neutral ThreadEvents and sent as
// `thread/event` {threadId, seq, at, event}. With LOTUS_CHAT_BRIDGE_RAW=1 the untranslated SDK
// messages are sent too, as `thread/raw` — for the fixture recorder and the smoke test.
//
//   bun run scripts/chat-bridge/main.ts

import { createInterface } from "node:readline";

import type { z } from "zod";

import type { ThreadEvent } from "../../src/modules/chat/domain/thread-event";
import { AcpTranslator } from "../../src/modules/chat/providers/acp/translate";
import { ApiTranslator } from "../../src/modules/chat/providers/api/translate";
import { ClaudeTranslator } from "../../src/modules/chat/providers/claude/translate";
import { CodexTranslator } from "../../src/modules/chat/providers/codex/translate";
import { AcpSession, listAcpCommands, listAcpModels, warmAcp, type AcpAgent } from "./acp-session";
import { ACP_AGENTS, acpAgent } from "../../src/modules/chat/providers/acp/agents";
import { ApiSession } from "./api-session";
import { ClaudeSession, childEnv, listCommands, listModels, sessionEnv } from "./claude-session";
import { CODEX_NOT_INSTALLED, CodexSession, killAllAgentProcesses, listCodexModels, listCodexSkills } from "./codex-session";
import {
  CHAT_BRIDGE_PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  bridgeRequestSchemas,
  inboundMessageSchema,
  interactionDecisionSchema,
  isBridgeMethod,
  type InteractionDecision,
  type ToolPermissionRequest,
} from "./protocol";
import { agentNameNote } from "./delegation-note";
import { resolveAgentExecutable, resolveClaudeExecutable, resolveCodexExecutable } from "./resolve-claude";

type RpcId = string | number;

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function log(line: string): void {
  process.stderr.write(`[chat-bridge] ${line}\n`);
}

interface Thread {
  session: ClaudeSession | CodexSession | ApiSession | AcpSession;
  translator: ClaudeTranslator | CodexTranslator | ApiTranslator | AcpTranslator;
  seq: number;
  rawSeq: number;
  /** The Agent Handle this session was last told (`agentNameNote`). */
  toldName?: string;
}

const SEND_RAW = process.env.LOTUS_CHAT_BRIDGE_RAW === "1";
const threads = new Map<string, Thread>();
const pendingHostReplies = new Map<RpcId, (decision: InteractionDecision) => void>();
let claudePath: string | null = null;
let codexPath: string | null = null;
// One model list per sign-in for the bridge's life, like bb's memo; a failed read is retried.
const modelLists = new Map<string, Promise<unknown>>();

function notify(method: string, params: Record<string, unknown>): void {
  write({ method, params });
}

function emit(threadId: string, thread: Thread, events: ThreadEvent[]): void {
  for (const event of events) {
    thread.seq += 1;
    notify("thread/event", { threadId, seq: thread.seq, at: Date.now(), event });
  }
}

async function requestPermission(request: ToolPermissionRequest): Promise<InteractionDecision> {
  // Stored in the thread's events, so it must stay unique across bridge restarts.
  const id = `interaction-${crypto.randomUUID()}`;
  const thread = threads.get(request.threadId);
  if (thread) emit(request.threadId, thread, thread.translator.interactionRequested(id, request));
  const decision = await new Promise<InteractionDecision>((resolve) => {
    pendingHostReplies.set(id, resolve);
    write({ id, method: "interaction/request", params: request });
  });
  if (thread) emit(request.threadId, thread, thread.translator.interactionResolved(id, decision));
  return decision;
}

function requireThread(threadId: string): Thread {
  const thread = threads.get(threadId);
  if (!thread) throw new Error(`unknown thread ${threadId}`);
  return thread;
}

async function handle(method: string, rawParams: unknown): Promise<unknown> {
  if (!isBridgeMethod(method)) throw Object.assign(new Error(`unknown method ${method}`), { code: RPC_METHOD_NOT_FOUND });
  const parsed = bridgeRequestSchemas[method].safeParse(rawParams ?? {});
  if (!parsed.success) throw Object.assign(new Error(parsed.error.message), { code: RPC_INVALID_PARAMS });

  switch (method) {
    case "initialize": {
      claudePath = resolveClaudeExecutable({ env: process.env });
      codexPath = resolveCodexExecutable({ env: process.env });
      return { protocolVersion: CHAT_BRIDGE_PROTOCOL_VERSION, providers: ["claude", "codex", "api", ...ACP_AGENTS.map((a) => a.id)], claudePath, codexPath };
    }
    case "thread/start": {
      const params = bridgeRequestSchemas["thread/start"].parse(rawParams);
      if (params.runner === "codex") return startCodex(params);
      if (params.runner === "api") return startApi(params);
      const acp = acpAgent(params.runner);
      if (acp) return startAcp(acp, params);
      if (!claudePath) throw new Error("claude executable not found; set LOTUS_CLAUDE_PATH");
      if (threads.has(params.threadId)) throw new Error(`thread ${params.threadId} already started`);
      const threadId = params.threadId;
      const translator = new ClaudeTranslator();
      const session: ClaudeSession = new ClaudeSession({
        threadId: params.threadId,
        cwd: params.cwd,
        claudePath,
        // The Lotus MCP sidecar reads it to know which chat delegates (lotus_chat_delegate).
        env: { ...sessionEnv(process.env, params.auth), LOTUS_CHAT_THREAD_ID: params.threadId },
        model: params.model,
        effort: params.effort,
        permissionMode: params.permissionMode,
        resumeSessionId: params.resumeSessionId,
        forkAt: params.forkAt,
        conciseReplies: params.conciseReplies,
        priorInputs: params.priorInputs,
        requestPermission,
        onMessage: (message) => {
          if (SEND_RAW) {
            thread.rawSeq += 1;
            notify("thread/raw", { threadId, seq: thread.rawSeq, event: message });
          }
          emit(threadId, thread, translator.translate(message));
        },
        onEnded: (error) => {
          emit(threadId, thread, thread.translator.end(error?.message ?? null));
          threads.delete(threadId);
          notify("thread/ended", {
            threadId,
            providerSessionId: session.providerSessionId,
            error: error?.message ?? null,
          });
        },
      });
      const thread: Thread = { session, translator, seq: 0, rawSeq: 0 };
      if (params.auth) thread.translator.requestedAuth = params.auth.mode === "apiKey" ? "apiKey" : "accountLogin";
      threads.set(threadId, thread);
      session.start();
      return { started: true };
    }
    case "turn/start":
    case "turn/steer": {
      const params = bridgeRequestSchemas[method].parse(rawParams);
      const startedAt = Date.now();
      const thread = requireThread(params.threadId);
      const uuid = crypto.randomUUID();
      const attachments = params.attachments.length > 0 ? params.attachments : undefined;
      thread.translator.noteInput({ text: params.text, clientRequestId: params.clientRequestId, attachments }, uuid);
      const note = agentNameNote(thread.toldName, params.agentName);
      thread.toldName = params.agentName || thread.toldName;
      const text = note ? `<lotus-instructions>\n${note}\n</lotus-instructions>\n\n${params.text}` : params.text;
      await thread.session.send(text, uuid, params.attachments);
      return { accepted: true, clientRequestId: params.clientRequestId, acceptedAfterMs: Date.now() - startedAt };
    }
    case "turn/interrupt": {
      const params = bridgeRequestSchemas["turn/interrupt"].parse(rawParams);
      const thread = requireThread(params.threadId);
      thread.translator.noteInterrupt();
      await thread.session.interrupt();
      return { interrupted: true };
    }
    case "thread/setModel": {
      const params = bridgeRequestSchemas["thread/setModel"].parse(rawParams);
      const { session } = requireThread(params.threadId);
      await (session instanceof CodexSession || session instanceof AcpSession ? session.setModel(params.model, params.effort) : session.setModel(params.model));
      return { model: params.model };
    }
    case "models/list": {
      const params = bridgeRequestSchemas["models/list"].parse(rawParams);
      if (params.runner === "codex") {
        const path = codexPath ?? resolveCodexExecutable({ env: process.env });
        if (!path) throw new Error(CODEX_NOT_INSTALLED);
        let list = modelLists.get("codex");
        if (!list) {
          list = listCodexModels(path, childEnv(process.env));
          list.catch(() => modelLists.delete("codex"));
          modelLists.set("codex", list);
        }
        return { models: await list };
      }
      const acp = acpAgent(params.runner);
      if (acp) {
        const path = acpPath(acp);
        let list = modelLists.get(acp.id);
        if (!list) {
          list = listAcpModels(acp, path, childEnv(process.env));
          list.catch(() => modelLists.delete(acp.id));
          modelLists.set(acp.id, list);
        }
        return { models: await list };
      }
      if (!claudePath) throw new Error("claude executable not found; set LOTUS_CLAUDE_PATH");
      const path = claudePath;
      const key = params.auth?.mode === "apiKey" ? `apiKey:${params.auth.apiKey}` : (params.auth?.mode ?? "env");
      let list = modelLists.get(key);
      if (!list) {
        list = listModels(path, sessionEnv(process.env, params.auth)).then((models) =>
          models.map(({ value, resolvedModel, displayName, description, supportedEffortLevels }) => ({
            value,
            resolvedModel,
            displayName,
            description,
            efforts: supportedEffortLevels ?? [],
          })),
        );
        list.catch(() => modelLists.delete(key));
        modelLists.set(key, list);
      }
      return { models: await list };
    }
    case "commands/list": {
      // Not cached here: skills change on disk, and the UI keeps its own copy.
      const params = bridgeRequestSchemas["commands/list"].parse(rawParams);
      if (params.runner === "codex") {
        const path = codexPath ?? resolveCodexExecutable({ env: process.env });
        if (!path) throw new Error(CODEX_NOT_INSTALLED);
        return { skills: await listCodexSkills(path, childEnv(process.env), params.cwd) };
      }
      const acp = acpAgent(params.runner);
      if (acp) return { commands: await listAcpCommands(acp, acpPath(acp), childEnv(process.env), params.cwd), skillNames: [] };
      if (params.runner !== "claude") return { commands: [], skillNames: [] };
      if (!claudePath) throw new Error("claude executable not found; set LOTUS_CLAUDE_PATH");
      return listCommands(claudePath, sessionEnv(process.env, params.auth), params.cwd);
    }
    case "thread/stop": {
      const params = bridgeRequestSchemas["thread/stop"].parse(rawParams);
      threads.get(params.threadId)?.session.stop();
      return { stopped: true };
    }
  }
}

async function startCodex(params: z.infer<(typeof bridgeRequestSchemas)["thread/start"]>): Promise<unknown> {
  // Looked up again: Codex may have been installed since the bridge started.
  codexPath ??= resolveCodexExecutable({ env: process.env });
  if (!codexPath) throw new Error(CODEX_NOT_INSTALLED);
  if (threads.has(params.threadId)) throw new Error(`thread ${params.threadId} already started`);
  const threadId = params.threadId;
  const translator = new CodexTranslator();
  const session: CodexSession = new CodexSession({
    threadId,
    cwd: params.cwd,
    codexPath,
    // The chat's Codex account (Settings › Accounts): its home dir is its login.
    env: {
      ...childEnv(process.env),
      ...(params.auth?.mode === "login" && params.auth.configDir ? { CODEX_HOME: params.auth.configDir } : {}),
      LOTUS_CHAT_THREAD_ID: params.threadId,
    },
    model: params.model,
    effort: params.effort,
    permissionMode: params.permissionMode,
    resumeSessionId: params.resumeSessionId,
    forkAt: params.forkAt,
    conciseReplies: params.conciseReplies,
    describe: (method, request) => translator.permission(method, request),
    requestPermission,
    onMessage: (message) => emit(threadId, thread, translator.translate(message)),
    onEnded: (error) => {
      emit(threadId, thread, translator.end(error?.message ?? null));
      threads.delete(threadId);
      notify("thread/ended", { threadId, providerSessionId: session.providerSessionId, error: error?.message ?? null });
    },
  });
  const thread: Thread = { session, translator, seq: 0, rawSeq: 0 };
  threads.set(threadId, thread);
  try {
    await session.start();
  } catch (error) {
    threads.delete(threadId);
    throw error;
  }
  return { started: true };
}

/** Looked up each time: the agent may have been installed since the bridge started. */
function acpPath(agent: AcpAgent): string {
  const path = resolveAgentExecutable(agent.binary, { env: process.env });
  if (!path) throw new Error(agent.notInstalled);
  return path;
}

async function startAcp(agent: AcpAgent, params: z.infer<(typeof bridgeRequestSchemas)["thread/start"]>): Promise<unknown> {
  const path = acpPath(agent);
  if (threads.has(params.threadId)) throw new Error(`thread ${params.threadId} already started`);
  const threadId = params.threadId;
  const translator = new AcpTranslator();
  const session: AcpSession = new AcpSession({
    threadId,
    cwd: params.cwd,
    agent,
    path,
    env: { ...childEnv(process.env), LOTUS_CHAT_THREAD_ID: threadId },
    model: params.model,
    effort: params.effort,
    permissionMode: params.permissionMode,
    resumeSessionId: params.resumeSessionId,
    conciseReplies: params.conciseReplies,
    describe: (request) => translator.permission(request),
    requestPermission,
    onMessage: (message) => emit(threadId, thread, translator.translate(message)),
    onEnded: (error) => {
      emit(threadId, thread, translator.end(error?.message ?? null));
      threads.delete(threadId);
      notify("thread/ended", { threadId, providerSessionId: session.providerSessionId, error: error?.message ?? null });
    },
  });
  const thread: Thread = { session, translator, seq: 0, rawSeq: 0 };
  threads.set(threadId, thread);
  try {
    await session.start();
  } catch (error) {
    threads.delete(threadId);
    throw error;
  }
  // The next chat starts on a booted process too.
  warmAcp(agent, path, childEnv(process.env)).catch(() => {});
  return { started: true };
}

function startApi(params: z.infer<(typeof bridgeRequestSchemas)["thread/start"]>): unknown {
  if (!params.api) throw new Error("an api thread needs its provider");
  if (threads.has(params.threadId)) throw new Error(`thread ${params.threadId} already started`);
  const threadId = params.threadId;
  const translator = new ApiTranslator();
  const session = new ApiSession({
    threadId,
    cwd: params.cwd,
    ...params.api,
    model: params.model,
    history: params.history,
    translator,
    emit: (events) => emit(threadId, thread, events),
    onEnded: (error) => {
      emit(threadId, thread, translator.end(error?.message ?? null));
      threads.delete(threadId);
      notify("thread/ended", { threadId, providerSessionId: null, error: error?.message ?? null });
    },
  });
  const thread: Thread = { session, translator, seq: 0, rawSeq: 0 };
  threads.set(threadId, thread);
  session.start();
  return { started: true };
}

function onLine(line: string): void {
  if (line.trim().length === 0) return;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    log(`dropped non-JSON line: ${line.slice(0, 120)}`);
    return;
  }
  const parsed = inboundMessageSchema.safeParse(json);
  if (!parsed.success) {
    log(`dropped invalid message: ${line.slice(0, 120)}`);
    return;
  }
  const message = parsed.data;

  if ("method" in message) {
    handle(message.method, message.params).then(
      (result) => write({ id: message.id, result }),
      (error: Error & { code?: number }) =>
        write({ id: message.id, error: { code: error.code ?? RPC_INTERNAL_ERROR, message: error.message } }),
    );
    return;
  }

  const reply = pendingHostReplies.get(message.id);
  if (!reply) return;
  pendingHostReplies.delete(message.id);
  if ("error" in message) {
    reply({ behavior: "deny", message: `host error: ${message.error.message}` });
    return;
  }
  const decision = interactionDecisionSchema.safeParse(message.result);
  reply(decision.success ? decision.data : { behavior: "deny", message: "host sent an invalid decision" });
}

function shutdown(): void {
  for (const thread of threads.values()) thread.session.stop();
  killAllAgentProcesses();
  process.exit(0);
}

createInterface({ input: process.stdin }).on("line", onLine).on("close", shutdown);
process.on("SIGTERM", shutdown);
log("ready");
