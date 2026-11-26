/**
 * The assistant brain behind Live Voice (mockups/live-voice-assistant.html): one ordinary Lotus Chat
 * thread per folder, "Lotus Assistant", that the realtime voice model hands real work to. Mode
 * neutral — Code, Canvas and Chat reach it through `work_on` (assistant-tools.ts).
 *
 * The thread runs in the "default" permission mode, never with permissions skipped: each action its
 * CLI would ask about arrives as an interaction, and `classifyBrainAction` decides it. A risky one is
 * handed back to the voice as a question, and runs only on the user's spoken yes (`decide`).
 */

import type { ThreadEventEnvelope } from "@/modules/chat/domain/thread-event";
import type { ApprovalDecision, PermissionMode } from "@/modules/chat/runtime/chat-runtime-client";
import { classifyBrainAction, describeBrainAction } from "./action-policy";
import type { AssistantSettings } from "./assistant-settings";

export const ASSISTANT_THREAD_TITLE = "Lotus Assistant";
/** How long a voice turn waits for the brain before saying it is still working. */
export const ASSISTANT_WAIT_MS = 45_000;

/** The slice of the Chat runtime the brain uses; injected so tests drive it without Tauri. */
export interface AssistantChatClient {
  createThread: (input: { cwd: string; runner: "claude" | "codex"; model: string | null; effort: string | null; permissionMode: PermissionMode }) => Promise<{ id: string }>;
  /** No user or project settings for this thread, so no `allow` rule there can skip `classifyBrainAction`. */
  lockPermissions: (threadId: string) => Promise<void>;
  rename: (threadId: string, title: string) => Promise<void>;
  /** Starts the thread's agent process ahead of the first message. */
  warm: (threadId: string) => Promise<void>;
  send: (threadId: string, text: string) => Promise<void>;
  subscribe: (threadId: string, onEvent: (envelope: ThreadEventEnvelope) => void, onReplayed: () => void) => Promise<() => void>;
  resolve: (threadId: string, interactionId: string, decision: ApprovalDecision) => Promise<void>;
}

/** Which thread is the brain for a folder, and the settings it was started with. */
export interface AssistantThreadStore {
  get: (cwd: string) => { threadId: string; config: string } | null;
  set: (cwd: string, value: { threadId: string; config: string } | null) => void;
}

export type BrainOutcome =
  | { kind: "answer"; text: string }
  /** The brain wants to do something risky; nothing runs until `decide`. */
  | { kind: "approval"; action: string }
  /** Still working after the wait; the answer stays in the brain thread for the next ask. */
  | { kind: "pending" }
  | { kind: "error"; message: string };

export interface AssistantBrain {
  /** Get the folder's thread and its agent process ready, so the first ask skips the cold start. */
  prepare: (cwd: string) => Promise<void>;
  ask: (cwd: string, text: string, options?: { newTopic?: boolean }) => Promise<BrainOutcome>;
  /** The user's spoken answer to the last approval question. */
  decide: (approve: boolean) => Promise<BrainOutcome>;
  /** Whether an approval question is waiting for a yes or no. */
  awaitingApproval: () => boolean;
  dispose: () => void;
}

export interface AssistantBrainDeps {
  client: AssistantChatClient;
  store: AssistantThreadStore;
  settings: () => AssistantSettings;
  waitMs?: number;
}

/** A thread is reused only while the settings that shaped it stay the same. */
export function brainConfigKey(settings: AssistantSettings): string {
  return JSON.stringify([settings.brain, settings.model, settings.effort, settings.delegateTo]);
}

/** The role, sent once at the top of a new thread (Chat has no per-thread system prompt). */
export function brainPreamble(settings: AssistantSettings): string {
  return [
    `You are the ${ASSISTANT_THREAD_TITLE}. The user talks to you through a live voice agent that reads your reply aloud.`,
    "Reply in one to three short plain sentences in the user's language: no markdown, no lists, no code blocks, no file paths unless asked.",
    "Answer quick questions yourself: read files, git status and log, the Lotus fleet, tasks, GitHub and Notion.",
    `For implementation or anything long, delegate with lotus_chat_delegate (provider "${settings.delegateTo}", worktree true), then say in one sentence what you started. Only send work to an open agent when the user names it.`,
    "Never stage with git add -A or git add .; stage only the files this request changed.",
    "Commit, push, merge or open a pull request only when the user asked for exactly that in this conversation.",
    "Some actions wait for the user's spoken yes; the app asks the user itself, so never ask for permission in your reply. If one is denied, say so in one sentence and stop.",
    "Never offer a list of options. If you need something, ask one short question as your reply.",
  ].join("\n");
}

const DENY_QUESTION = "The user is on a voice call and cannot pick options. Ask one short question in your reply instead.";
const DENY_MOVED_ON = "The user moved on without saying yes.";
const DENY_NO = "The user said no.";

interface Attached {
  cwd: string;
  threadId: string;
  config: string;
  unsubscribe: () => void;
  /** Resolves once the stored history has replayed; events before it are history, not answers. */
  ready: Promise<void>;
  fresh: boolean;
}

export function createAssistantBrain({ client, store, settings, waitMs = ASSISTANT_WAIT_MS }: AssistantBrainDeps): AssistantBrain {
  let attached: Attached | null = null;
  let live = false;
  let waiter: { settle: (outcome: BrainOutcome) => void } | null = null;
  let reply: string | null = null;
  let pending: { threadId: string; interactionId: string } | null = null;
  let disposed = false;
  /** A `prepare` still running; an ask waits for it so the two never create two threads. */
  let preparing: Promise<void> | null = null;

  const settle = (outcome: BrainOutcome) => {
    const current = waiter;
    waiter = null;
    current?.settle(outcome);
  };

  const wait = (): Promise<BrainOutcome> => {
    settle({ kind: "pending" });
    reply = null;
    return new Promise<BrainOutcome>((resolve) => {
      const timer = setTimeout(() => settle({ kind: "pending" }), waitMs);
      waiter = {
        settle: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      };
    });
  };

  const resolveInteraction = (threadId: string, interactionId: string, decision: ApprovalDecision) =>
    client.resolve(threadId, interactionId, decision).catch((error: unknown) => {
      settle({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    });

  const onEvent = (threadId: string, { event }: ThreadEventEnvelope) => {
    if (!live || attached?.threadId !== threadId) return;
    switch (event.type) {
      case "item/completed":
        if (event.item.kind === "agentMessage" && event.item.text.trim()) reply = event.item.text.trim();
        return;
      case "interaction/requested": {
        const { interaction } = event;
        if (interaction.kind === "question") {
          void resolveInteraction(threadId, interaction.id, { behavior: "deny", message: DENY_QUESTION });
          return;
        }
        if (classifyBrainAction(interaction.toolName, interaction.input, settings().confirm) === "allow") {
          void resolveInteraction(threadId, interaction.id, { behavior: "allow" });
          return;
        }
        pending = { threadId, interactionId: interaction.id };
        settle({ kind: "approval", action: describeBrainAction(interaction.toolName, interaction.input) });
        return;
      }
      case "interaction/resolved":
        // Answered in the Chat thread by hand: the voice no longer holds a question.
        if (pending?.interactionId === event.interactionId) pending = null;
        return;
      case "turn/answered":
        settle({ kind: "answer", text: reply ?? "Done." });
        return;
      case "turn/completed":
        if (event.status === "failed") settle({ kind: "error", message: event.error ?? "The assistant's turn failed." });
        else settle({ kind: "answer", text: reply ?? "Done." });
        return;
      case "session/ended":
        if (event.error) settle({ kind: "error", message: event.error });
        return;
    }
  };

  const detach = () => {
    attached?.unsubscribe();
    attached = null;
    live = false;
  };

  const attach = async (cwd: string, threadId: string, config: string, fresh: boolean): Promise<Attached> => {
    detach();
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    const unsubscribe = await client.subscribe(threadId, (envelope) => onEvent(threadId, envelope), () => {
      live = true;
      markReady();
    });
    attached = { cwd, threadId, config, unsubscribe, ready, fresh };
    return attached;
  };

  /** The brain thread for this folder and these settings: the one in use, a stored one, or a new one. */
  const ensure = async (cwd: string, newTopic: boolean): Promise<Attached> => {
    const current = settings();
    const config = brainConfigKey(current);
    if (newTopic) store.set(cwd, null);
    if (!newTopic && attached?.cwd === cwd && attached.config === config) return attached;
    const stored = newTopic ? null : store.get(cwd);
    if (stored && stored.config === config) return attach(cwd, stored.threadId, config, false);
    if (current.brain === "off") throw new Error("The assistant brain is off.");
    const thread = await client.createThread({
      cwd,
      runner: current.brain,
      model: current.model || null,
      effort: current.effort || null,
      permissionMode: "default",
    });
    // Before the first message starts its session, and fail closed: an unlocked brain is never used.
    await client.lockPermissions(thread.id);
    store.set(cwd, { threadId: thread.id, config });
    // The title only helps find it in the rail; a failed rename must not lose the request.
    await client.rename(thread.id, ASSISTANT_THREAD_TITLE).catch(() => {});
    return attach(cwd, thread.id, config, true);
  };

  const sendTo = async (target: Attached, text: string) => {
    await target.ready;
    await client.send(target.threadId, target.fresh ? `${brainPreamble(settings())}\n\nRequest: ${text}` : text);
    target.fresh = false;
  };

  const denyPending = async () => {
    if (!pending) return;
    const { threadId, interactionId } = pending;
    pending = null;
    await client.resolve(threadId, interactionId, { behavior: "deny", message: DENY_MOVED_ON }).catch(() => {});
  };

  return {
    prepare(cwd) {
      if (disposed || settings().brain === "off") return Promise.resolve();
      const run = (preparing ?? Promise.resolve())
        // Only a thread this folder already has: a session that never asks must not leave an empty
        // "Lotus Assistant" in the rail. A new folder pays the cold start once, on its first ask.
        .then(async () => {
          if (store.get(cwd)?.config !== brainConfigKey(settings())) return;
          const target = await ensure(cwd, false);
          await client.warm(target.threadId);
        })
        // Only a head start: the ask that follows creates or reports whatever failed here.
        .catch(() => {});
      preparing = run;
      void run.then(() => {
        if (preparing === run) preparing = null;
      });
      return run;
    },

    async ask(cwd, text, options = {}) {
      if (disposed) return { kind: "error", message: "The assistant is closed." };
      if (settings().brain === "off") return { kind: "error", message: "The assistant brain is off in Settings." };
      const request = text.trim();
      if (!request) return { kind: "error", message: "Nothing to ask." };
      await preparing;
      await denyPending();
      try {
        const target = await ensure(cwd, options.newTopic === true);
        const outcome = wait();
        try {
          await sendTo(target, request);
        } catch (error) {
          if (target.fresh) throw error;
          // A stored thread can be gone (deleted from the rail): start a new one, once.
          store.set(cwd, null);
          await sendTo(await ensure(cwd, true), request);
        }
        return await outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        settle({ kind: "error", message });
        return { kind: "error", message };
      }
    },

    async decide(approve) {
      if (!pending) return { kind: "error", message: "Nothing is waiting for a yes." };
      const { threadId, interactionId } = pending;
      pending = null;
      const outcome = wait();
      await resolveInteraction(threadId, interactionId, approve ? { behavior: "allow" } : { behavior: "deny", message: DENY_NO });
      return outcome;
    },

    awaitingApproval: () => pending !== null,

    dispose() {
      disposed = true;
      void denyPending();
      settle({ kind: "error", message: "The assistant is closed." });
      detach();
    },
  };
}
