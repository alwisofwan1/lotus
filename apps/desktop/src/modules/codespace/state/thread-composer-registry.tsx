"use client";

import React, { createContext, useContext, useMemo, useRef } from "react";

/**
 * How one command bar outside a conversation sends a message INTO it.
 *
 * The shell's composer knows the focused pane and the text; it does not know how to start a run,
 * which model the thread is on, what is attached to it, or what context prefixes belong on the
 * prompt. The chat knows all of that, in one function. So the pane registers that function here
 * and the composer calls it — nothing is re-implemented, so nothing can drift. A typed channel
 * beats a window event. Keyed by the pane's id (07d), which exists before its thread does.
 */

export type ThreadComposerSend = (text: string) => void;

/**
 * The thread's own input, for a **Held Prompt** (ADR-0064): spoken text put there unsent, then sent
 * or cleared from the shell's composer. Registered by the input that owns the text.
 */
export interface ThreadPromptHandle {
  /** Add the text to the input, unsent. */
  insert(text: string): void;
  /** Send what the input holds, with `extra` after it, as one message. False — and nothing changed —
   *  when it cannot now (empty, or the thread is still answering: its Enter would stop that run). */
  submit(extra?: string): boolean;
  /** Take `text` back out where it ends the input, keeping whatever the user had typed before it. */
  remove(text: string): void;
}

/** What became of a Held Prompt sent to a thread: gone means no input holds it any more. */
export type ThreadPromptSubmit = "sent" | "answering" | "gone";

export interface ThreadComposerRegistry {
  /** Called by the conversation. Returns the unregister function for its effect cleanup. */
  register(sessionId: string, send: ThreadComposerSend): () => void;
  /** Called by the composer. False when no live conversation is listening for that session. */
  send(sessionId: string, text: string): boolean;
  /** Called by the thread's input. Returns the unregister function for its effect cleanup. */
  registerPrompt(sessionId: string, handle: ThreadPromptHandle): () => void;
  /** False when that thread has no input that takes unsent text. */
  insert(sessionId: string, text: string): boolean;
  submit(sessionId: string, extra?: string): ThreadPromptSubmit;
  remove(sessionId: string, text: string): boolean;
  /** Called by the thread's input when it becomes empty — sent or cleared, from wherever. */
  promptEmptied(sessionId: string): void;
  /** Called by the composer, to forget a Held Prompt that is no longer there. */
  onPromptEmptied(listener: (sessionId: string) => void): () => void;
}

const ThreadComposerRegistryContext = createContext<ThreadComposerRegistry | null>(null);

export function useCreateThreadComposerRegistry(): ThreadComposerRegistry {
  // A ref, not state: a conversation mounting must not re-render the shell above it, and the
  // handler is only read at the moment someone presses Enter.
  const sends = useRef(new Map<string, ThreadComposerSend>());
  const prompts = useRef(new Map<string, ThreadPromptHandle>());
  const emptiedListeners = useRef(new Set<(sessionId: string) => void>());

  return useMemo<ThreadComposerRegistry>(
    () => ({
      register(sessionId, send) {
        sends.current.set(sessionId, send);
        return () => {
          // Only if it is still ours: a remount registers the new handler before the old one
          // cleans up, and an unconditional delete would drop the live one.
          if (sends.current.get(sessionId) === send) sends.current.delete(sessionId);
        };
      },
      send(sessionId, text) {
        const send = sends.current.get(sessionId);
        if (!send) return false;
        send(text);
        return true;
      },
      registerPrompt(sessionId, handle) {
        prompts.current.set(sessionId, handle);
        return () => {
          if (prompts.current.get(sessionId) === handle) prompts.current.delete(sessionId);
        };
      },
      insert(sessionId, text) {
        const prompt = prompts.current.get(sessionId);
        if (!prompt) return false;
        prompt.insert(text);
        return true;
      },
      submit(sessionId, extra) {
        const prompt = prompts.current.get(sessionId);
        if (!prompt) return "gone";
        return prompt.submit(extra) ? "sent" : "answering";
      },
      remove(sessionId, text) {
        const prompt = prompts.current.get(sessionId);
        if (!prompt) return false;
        prompt.remove(text);
        return true;
      },
      promptEmptied(sessionId) {
        for (const listener of emptiedListeners.current) listener(sessionId);
      },
      onPromptEmptied(listener) {
        emptiedListeners.current.add(listener);
        return () => {
          emptiedListeners.current.delete(listener);
        };
      },
    }),
    [],
  );
}

export function ThreadComposerRegistryProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value?: ThreadComposerRegistry;
}) {
  const fallback = useCreateThreadComposerRegistry();
  return (
    <ThreadComposerRegistryContext.Provider value={value ?? fallback}>
      {children}
    </ThreadComposerRegistryContext.Provider>
  );
}

/** Null when nothing above is offering to route messages — the `/codechat` route, or a test. */
export function useThreadComposerRegistry(): ThreadComposerRegistry | null {
  return useContext(ThreadComposerRegistryContext);
}
