// Chat bridge wire protocol, v0 (spike). JSON-RPC 2.0, one message per line over stdio.
// Shape follows bb's provider bridge protocol (docs/provider-bridge-protocol.md), trimmed to
// what the spike proves: start, send, steer, interrupt, stop, and tool approval.

import { z } from "zod";
import { ACP_AGENTS, type AcpRunner } from "../../src/modules/chat/providers/acp/agents";

export const CHAT_BRIDGE_PROTOCOL_VERSION = 0;

export const permissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);

// The sign-in a session starts with (#277). Absent: the bridge's own environment decides, as before.
export const sessionAuthSchema = z.discriminatedUnion("mode", [
  // configDir: the ccs account picked in Lotus's usage popover; absent = Claude's default login.
  z.object({ mode: z.literal("login"), configDir: z.string().min(1).optional() }),
  z.object({ mode: z.literal("apiKey"), apiKey: z.string().min(1) }),
]);
export type SessionAuth = z.infer<typeof sessionAuthSchema>;

// Which agent runs a thread (#286). Fixed per thread: the conversation lives in that agent's session.
// "api" (#288): an OpenAI-compatible /chat/completions endpoint, text only.
// The rest: the `acp` agents of src/agents.json, over the Agent Client Protocol (plans/chat-acp-runners/PLAN.md).
export const runnerSchema = z.enum(["claude", "codex", "api", ...ACP_AGENTS.map((a) => a.id)] as ["claude", "codex", "api", ...AcpRunner[]]);
export type Runner = z.infer<typeof runnerSchema>;

export const threadStartParams = z.object({
  threadId: z.string().min(1),
  runner: runnerSchema.default("claude"),
  // Reasoning effort ("low" … "max"), as the model list offers it for this model.
  effort: z.string().min(1).optional(),
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  permissionMode: permissionModeSchema.default("default"),
  resumeSessionId: z.string().min(1).optional(),
  // A fork's first start (mockups/chat-fork-turn.html): branch `resumeSessionId` at this point —
  // Claude's last chain uuid of the turn, Codex's turn id. The host drops it once the fork has its own session.
  forkAt: z.string().min(1).optional(),
  // Settings › Chat › Reading › Concise replies, read by the host at each session start.
  conciseReplies: z.boolean().default(false),
  // A chat Lotus delegated: "worker" (lotus_chat_delegate) or "verifier" (Delegate Verify). It is
  // told to do the task itself instead of how to delegate.
  subAgent: z.enum(["worker", "verifier"]).optional(),
  // The Live Voice assistant brain (mockups/live-voice-assistant.html): no user or project
  // settings, so no `allow` rule there can skip the app's approval. Set by the host per thread, never cleared.
  strictPermissions: z.boolean().default(false),
  auth: sessionAuthSchema.optional(),
  // The "api" runner's endpoint and key (#288), from the host's model registry.
  api: z
    .object({ baseUrl: z.string().url(), apiKey: z.string().min(1).nullable(), providerName: z.string().min(1) })
    .optional(),
  // The conversation so far, rebuilt by the host: the API keeps none of its own.
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).default([]),
  // A resumed Claude chat: what the user sent before that may name a path outside `cwd`, so Claude
  // reads those again without asking, as it did in the session that saw them first.
  priorInputs: z
    .array(z.object({ text: z.string(), attachments: z.array(z.object({ kind: z.enum(["image", "file"]), path: z.string().min(1) })) }))
    .default([]),
});

// What Claude takes as a picture inside the message; any other file goes by its path (#279).
export { IMAGE_MIME_TYPES } from "../../src/modules/chat/domain/attachments";

export const attachmentParams = z.object({
  kind: z.enum(["image", "file"]),
  path: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
});
export type AttachmentParams = z.infer<typeof attachmentParams>;

export const turnSendParams = z
  .object({
    threadId: z.string().min(1),
    text: z.string(),
    clientRequestId: z.string().min(1),
    attachments: z.array(attachmentParams).default([]),
    // The thread's Agent Handle (ADR-0068); the bridge tells the agent when it is new to this session.
    agentName: z.string().min(1).nullish(),
  })
  .refine((p) => p.text.trim().length > 0 || p.attachments.length > 0, { message: "message is empty" });

export const threadRefParams = z.object({ threadId: z.string().min(1) });

// #278. "default" is Claude's own default, which `query.setModel()` takes as no model.
export const setModelParams = z.object({ threadId: z.string().min(1), model: z.string().min(1), effort: z.string().min(1).optional() });

// The models the sign-in can use, from Claude itself (`supportedModels()`), not a Lotus catalog.
export const modelsListParams = z.object({ runner: runnerSchema.default("claude"), auth: sessionAuthSchema.optional() });

// What `/` offers in a folder, from the agent itself (plans/chat-skills/PLAN.md).
export const commandsListParams = z.object({ runner: runnerSchema.default("claude"), cwd: z.string().min(1), auth: sessionAuthSchema.optional() });

export const bridgeRequestSchemas = {
  initialize: z.object({}).passthrough(),
  "thread/start": threadStartParams,
  "turn/start": turnSendParams,
  "turn/steer": turnSendParams,
  "turn/interrupt": threadRefParams,
  "thread/stop": threadRefParams,
  "thread/setModel": setModelParams,
  "models/list": modelsListParams,
  "commands/list": commandsListParams,
} as const;

export type BridgeMethod = keyof typeof bridgeRequestSchemas;

export const interactionDecisionSchema = z.discriminatedUnion("behavior", [
  // `answers` answers an AskUserQuestion: question text → chosen labels joined with ", ", or the user's words.
  // `remember` keeps the Allow for the rest of the session, where the request offered it.
  z.object({ behavior: z.literal("allow"), answers: z.record(z.string(), z.string()).optional(), remember: z.boolean().optional() }),
  z.object({ behavior: z.literal("deny"), message: z.string().min(1) }),
]);

export type InteractionDecision = z.infer<typeof interactionDecisionSchema>;

export interface ToolPermissionRequest {
  threadId: string;
  kind: "tool-permission";
  toolName: string;
  toolUseId: string | null;
  input: Record<string, unknown>;
  blockedPath: string | null;
  /** The provider can keep an Allow for the rest of the session. */
  remember?: boolean;
}

const rpcId = z.union([z.string(), z.number()]);

export const inboundMessageSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: rpcId, method: z.string(), params: z.unknown().optional() }),
  z.object({ jsonrpc: z.literal("2.0"), id: rpcId, result: z.unknown() }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: rpcId,
    error: z.object({ code: z.number(), message: z.string() }),
  }),
]);

export type InboundMessage = z.infer<typeof inboundMessageSchema>;

export function isBridgeMethod(method: string): method is BridgeMethod {
  return Object.prototype.hasOwnProperty.call(bridgeRequestSchemas, method);
}

export const RPC_INVALID_PARAMS = -32602;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;
