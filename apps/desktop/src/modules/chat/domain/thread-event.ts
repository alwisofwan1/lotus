// The provider-neutral event model of a chat thread. Every provider (Claude Agent SDK, Codex,
// HTTP models) is translated into these events in the bridge; the store, the projection and the
// UI only ever see these. Shapes follow bb `packages/domain` (MIT), reduced to what Lotus uses.
//
// Rules: no provider names, no React. A schema change here is a wire change between the bridge,
// the Rust runtime and the frontend — bump THREAD_EVENT_VERSION.

import "@/lib/zod-jitless"; // its only user since CodeChat's tools went (07p): keeps the CSP probe off
import { z } from "zod";

export const THREAD_EVENT_VERSION = 7;

export const itemStatusSchema = z.enum(["running", "completed", "failed", "declined", "interrupted"]);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

// One hunk of a unified diff. `lines` keep their " ", "+" or "-" prefix.
export const patchHunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});
export type PatchHunk = z.infer<typeof patchHunkSchema>;

// Something sent with a message (#279). Only what it is and where: images go to the provider as
// pictures, files by `path` (the user's own file; a pasted one is a copy Lotus keeps).
export const attachmentSchema = z.object({
  kind: z.enum(["image", "file"]),
  path: z.string(),
  name: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  /** Its path on the chat's machine once copied there (ADR-0069); `path` stays this Mac's. */
  remote: z.string().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

// `parentId`: the sub-agent call (Claude's Agent tool) this item ran inside; absent at the top level.
const itemBase = { id: z.string(), status: itemStatusSchema, parentId: z.string().optional() };

export const threadItemSchema = z.discriminatedUnion("kind", [
  z.object({ ...itemBase, kind: z.literal("agentMessage"), text: z.string() }),
  z.object({ ...itemBase, kind: z.literal("reasoning"), text: z.string() }),
  // A message the user sent while the turn ran, which the agent took in mid-turn (a steer).
  z.object({
    ...itemBase,
    kind: z.literal("userMessage"),
    text: z.string(),
    clientRequestId: z.string(),
    attachments: z.array(attachmentSchema).optional(),
  }),
  z.object({
    ...itemBase,
    kind: z.literal("command"),
    command: z.string(),
    description: z.string().nullable(),
    output: z.string().nullable(),
  }),
  z.object({ ...itemBase, kind: z.literal("fileRead"), path: z.string(), lineCount: z.number().nullable() }),
  z.object({
    ...itemBase,
    kind: z.literal("fileChange"),
    path: z.string(),
    change: z.enum(["create", "edit"]),
    patch: z.array(patchHunkSchema).nullable(),
  }),
  z.object({ ...itemBase, kind: z.literal("search"), query: z.string(), output: z.string().nullable() }),
  // Any tool without a dedicated kind (web fetch, MCP tools, sub-agents, …). A sub-agent's own
  // steps carry its id as `parentId`.
  z.object({
    ...itemBase,
    kind: z.literal("tool"),
    name: z.string(),
    input: z.unknown(),
    output: z.string().nullable(),
  }),
]);
export type ThreadItem = z.infer<typeof threadItemSchema>;
export type ThreadItemKind = ThreadItem["kind"];

export const turnInputSchema = z.object({
  text: z.string(),
  clientRequestId: z.string(),
  attachments: z.array(attachmentSchema).optional(),
});
export type TurnInput = z.infer<typeof turnInputSchema>;

export const turnStatusSchema = z.enum(["completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

export const turnUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  /** The last main-agent call's prompt size: how full the context window is. Claude only; absent on older turns. */
  contextTokens: z.number().nullable().optional(),
  contextWindow: z.number().nullable().optional(),
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;

// "accountLogin": the user's own provider login (no API key). See plans/chat-runtime/PLAN.md,
// "Decided 2026-10-27 — option A": the UI must show which one is in use.
export const authSourceSchema = z.enum(["apiKey", "accountLogin", "unknown"]);
export type AuthSource = z.infer<typeof authSourceSchema>;

export const questionSchema = z.object({
  question: z.string(),
  // A short label for the question, e.g. "Library".
  header: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().nullable() })),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof questionSchema>;

export const interactionSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("toolPermission"),
    // The tool item this request is for, when the provider says which one.
    itemId: z.string().nullable(),
    toolName: z.string(),
    input: z.unknown(),
    blockedPath: z.string().nullable(),
    // The provider can keep an Allow for the rest of the session (Codex MCP tools).
    remember: z.boolean().optional(),
  }),
  // The agent asks the user to choose; answered with one text per question.
  z.object({ id: z.string(), kind: z.literal("question"), itemId: z.string().nullable(), questions: z.array(questionSchema) }),
]);
export type Interaction = z.infer<typeof interactionSchema>;

export const threadEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session/configured"),
    providerSessionId: z.string().nullable(),
    model: z.string().nullable(),
    authSource: authSourceSchema,
    /** What Lotus asked for (#277); absent in sessions started before that, or without a setting. */
    requestedAuth: authSourceSchema.optional(),
    cwd: z.string().nullable(),
  }),
  // The user picked another model (#278). It applies from the next message; `label` is the name they saw.
  // `effort`: Codex's reasoning effort, picked with the model (#286).
  z.object({ type: z.literal("session/modelChanged"), model: z.string(), label: z.string(), effort: z.string().optional() }),
  // The thread moved to another ccs Claude account; its next message resumes the session there.
  z.object({ type: z.literal("session/accountChanged"), account: z.string() }),
  // The user picked another permission mode; the next message resumes the session in it.
  z.object({ type: z.literal("session/permissionChanged"), mode: z.string(), label: z.string() }),
  // Claude's `rate_limit_event` when it is not plain "allowed": allowed_warning or rejected.
  z.object({
    type: z.literal("session/rateLimit"),
    status: z.string(),
    rateLimitType: z.string().nullable(),
    resetsAtMs: z.number().nullable(),
  }),
  // How many background tasks (shell, Monitor, agent) the session still runs. Claude ends a turn while
  // they run and wakes by itself when one settles, so a thread with any is not done (Delegate Verify).
  z.object({ type: z.literal("session/background"), running: z.number().int().nonnegative() }),
  z.object({ type: z.literal("turn/started"), turnId: z.string(), input: turnInputSchema.nullable() }),
  z.object({
    type: z.literal("turn/completed"),
    turnId: z.string(),
    status: turnStatusSchema,
    error: z.string().nullable(),
    usage: turnUsageSchema.nullable(),
    /** Where a fork can branch off through this turn: the provider's own id for it. Absent on older turns. */
    forkPoint: z.string().nullable().optional(),
  }),
  // The agent gave its closing reply (Claude's `end_turn`); only Stop hooks are left before
  // `turn/completed`, and they can take seconds to minutes. A later item means a hook made it go on.
  z.object({ type: z.literal("turn/answered"), turnId: z.string() }),
  z.object({ type: z.literal("item/started"), turnId: z.string(), item: threadItemSchema }),
  // Streamed text for agentMessage and reasoning items.
  z.object({ type: z.literal("item/delta"), turnId: z.string(), itemId: z.string(), delta: z.string() }),
  z.object({ type: z.literal("item/completed"), turnId: z.string(), item: threadItemSchema }),
  z.object({ type: z.literal("interaction/requested"), turnId: z.string().nullable(), interaction: interactionSchema }),
  z.object({
    type: z.literal("interaction/resolved"),
    interactionId: z.string(),
    decision: z.enum(["allowed", "denied", "answered"]),
    message: z.string().nullable(),
    // For "answered": question text → the chosen labels joined with ", ", or the user's own words.
    answers: z.record(z.string(), z.string()).nullable().default(null),
  }),
  z.object({ type: z.literal("session/ended"), error: z.string().nullable() }),
  // This chat began as a copy of another one's turns up to `turn` (mockups/chat-fork-turn.html).
  z.object({ type: z.literal("thread/forked"), fromThreadId: z.string(), fromTitle: z.string(), turn: z.number(), turnId: z.string().optional() }),
  // The fork moved into its own git worktree, its files as at the forked turn (mockups/chat-fork-worktree.html).
  z.object({ type: z.literal("thread/worktree"), branch: z.string() }),
  // A sent message was edited (mockups/chat-user-actions.html): its turn and all after it leave the conversation.
  z.object({ type: z.literal("thread/rewound"), turnId: z.string() }),
]);
export type ThreadEvent = z.infer<typeof threadEventSchema>;

// What the bridge sends and the store keeps: one event, its order in the thread and its time.
export const threadEventEnvelopeSchema = z.object({
  threadId: z.string(),
  seq: z.number().int().positive(),
  at: z.number(),
  event: threadEventSchema,
});
export type ThreadEventEnvelope = z.infer<typeof threadEventEnvelopeSchema>;
