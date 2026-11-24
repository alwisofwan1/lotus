"use client";
import { useEffect, useRef, useState } from "react";
import { writeToSession } from "@/lib/tauri-api";
import type { GridCell } from "@/modules/codespace/components/types";
import { createCellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import { attachCellBus } from "@/modules/codespace/services/terminal-session-registry";
import type { ThreadComposerRegistry } from "@/modules/codespace/state/thread-composer-registry";
import type { VoiceTurnTarget } from "@/modules/voice-core/voice-adapter";
import { CODE_VOICE_REVIEW_REASON, type CodeVoiceSendOutcome } from "../services/code-voice-adapter";
import { ptyWritesForHeldPrompt, ptyWritesForMessage, ptyWritesToClearHeldPrompt, type ComposerRoute } from "../services/composer-routing";
import { paneRunnerIdentity } from "../services/pane-runner-identity";

type PaneRoute = Exclude<ComposerRoute, { kind: "blocked" }>;

/** Where a Held Prompt waits: a terminal agent's line editor, or a thread's own input. */
export type HeldPromptPlace = { kind: "terminal"; runtimeSessionId: string } | { kind: "thread"; sessionId: string };

export interface HeldPrompt {
  paneId: string;
  name: string;
  place: HeldPromptPlace;
  text: string;
  /** The text was cleaned up by AI. No Undo: it is in the agent's prompt now. */
  cleaned: boolean;
  /** Bumps on every turn placed, so the composer takes focus again. */
  seq: number;
  /** Characters typed into a terminal pane by hand since: Escape has that much more to clear. */
  typedInPane: number;
}

export const HELD_PROMPT_UNREACHABLE = "Couldn't reach that pane.";

export function heldPromptBusyReason(name: string): string {
  return `${name} still has unsent text in its prompt — Enter sends it, Esc clears it.`;
}

export function heldPromptAnsweringReason(name: string): string {
  return `${name} is still answering — press Enter again once it is done.`;
}

function samePlace(a: HeldPromptPlace, route: PaneRoute): boolean {
  return a.kind === "terminal"
    ? route.kind === "terminal" && route.runtimeSessionId === a.runtimeSessionId
    : route.kind === "thread" && route.sessionId === a.sessionId;
}

function stillThere(held: HeldPrompt, cells: GridCell[]): boolean {
  const { place } = held;
  return cells.some((cell) =>
    cell.id !== held.paneId
      ? false
      : place.kind === "terminal"
        ? cell.type === "terminal" && cell.runtimeSessionId === place.runtimeSessionId
        : cell.type === "chat" && cell.sessionId === place.sessionId,
  );
}

/**
 * A **Held Prompt** (ADR-0064): a spoken turn waiting, unsent, in an agent's own prompt — a terminal
 * agent's line editor, or a thread's input. The shell's composer sends it on Enter and clears it on
 * Escape. Forgotten when its pane closes (or gets a new session) and when it is sent or emptied from
 * the pane itself. One at a time: a second one would leave the first in its prompt with nothing in
 * the composer to send or clear it.
 */
export function useHeldPrompt({
  cells,
  threadComposers,
  onSent,
}: {
  /** Every folder's panes, not just the one on screen: switching folders does not close a pane. */
  cells: GridCell[];
  threadComposers: ThreadComposerRegistry | null;
  /** A Held Prompt in a terminal was sent from the composer: the pane may take its title from it. */
  onSent?: (paneId: string, text: string) => void;
}) {
  const [held, setHeld] = useState<HeldPrompt | null>(null);
  const heldRef = useRef(held);
  useEffect(() => {
    heldRef.current = held;
  });
  if (held && !stillThere(held, cells)) setHeld(null);

  /*
    What the user does in a terminal pane itself. A keystroke carrying a carriage return sent the
    prompt. Read from the raw data, not `submitted`: the input tracker never saw the Held Prompt's
    text (it was written straight to the PTY), so a bare Enter in the pane reports nothing submitted.
  */
  const terminalPaneId = held?.place.kind === "terminal" ? held.paneId : undefined;
  useEffect(() => {
    if (!terminalPaneId) return;
    const bus = createCellBus();
    const detach = attachCellBus(bus);
    const offInput = bus.on("terminal:input", (event) => {
      if (event.paneId !== terminalPaneId || event.origin !== "human") return;
      if (/[\r\n]/.test(event.data)) setHeld(null);
      else setHeld((current) => (current ? { ...current, typedInPane: current.typedInPane + event.data.length } : current));
    });
    const offExit = bus.on("terminal:exited", (event) => {
      if (event.paneId === terminalPaneId) setHeld(null);
    });
    return () => {
      offInput();
      offExit();
      detach();
      bus.clear();
    };
  }, [terminalPaneId]);

  // A thread's input says when it became empty: sent or cleared there, or by the composer.
  const threadSessionId = held?.place.kind === "thread" ? held.place.sessionId : undefined;
  useEffect(() => {
    if (!threadSessionId || !threadComposers) return;
    return threadComposers.onPromptEmptied((sessionId) => {
      if (sessionId === threadSessionId) setHeld(null);
    });
  }, [threadComposers, threadSessionId]);

  /** Put a spoken turn, unsent, in the pane's own prompt. */
  async function place(text: string, route: PaneRoute, target: VoiceTurnTarget, spoken?: string): Promise<CodeVoiceSendOutcome> {
    const previous = heldRef.current;
    const continues = Boolean(previous && previous.paneId === route.paneId && samePlace(previous.place, route));
    if (previous && !continues) return { ok: false, reason: heldPromptBusyReason(previous.name) };

    let where: HeldPromptPlace;
    if (route.kind === "terminal") {
      // A plain shell has no prompt to hold text in: Enter there runs a command.
      const cell = cells.find((candidate) => candidate.id === route.paneId);
      if (!cell || !paneRunnerIdentity(cell)) return { ok: false, reason: CODE_VOICE_REVIEW_REASON };
      try {
        for (const chunk of ptyWritesForHeldPrompt(text, continues)) await writeToSession(route.runtimeSessionId, chunk);
      } catch {
        return { ok: false, reason: HELD_PROMPT_UNREACHABLE };
      }
      where = { kind: "terminal", runtimeSessionId: route.runtimeSessionId };
    } else {
      // A thread without a registered input cannot take unsent text.
      if (!threadComposers?.insert(route.sessionId, text.trim())) return { ok: false, reason: CODE_VOICE_REVIEW_REASON };
      where = { kind: "thread", sessionId: route.sessionId };
    }

    const cleaned = Boolean(spoken && spoken.trim() !== text.trim());
    setHeld((current) => ({
      paneId: route.paneId,
      name: target.name,
      place: where,
      text: continues && current ? `${current.text} ${text.trim()}` : text.trim(),
      cleaned: cleaned || Boolean(continues && current?.cleaned),
      seq: (current?.seq ?? 0) + 1,
      typedInPane: continues && current ? current.typedInPane : 0,
    }));
    return { ok: true };
  }

  /** Send what the thread's input holds, `extra` after it, as one message — or change nothing. */
  function submitToThread(current: HeldPrompt, extra?: string): CodeVoiceSendOutcome {
    if (current.place.kind !== "thread") return { ok: false, reason: HELD_PROMPT_UNREACHABLE };
    const result = threadComposers?.submit(current.place.sessionId, extra) ?? "gone";
    if (result === "answering") {
      // Kept while the thread is still answering: its own Enter would stop that run instead. A typed
      // message waits there with it (the composer already let go of it), so the next Enter sends both.
      const typed = extra?.trim();
      if (typed && threadComposers?.insert(current.place.sessionId, typed)) setHeld({ ...current, text: `${current.text} ${typed}` });
      return { ok: false, reason: heldPromptAnsweringReason(current.name) };
    }
    // No input holds the text any more (the thread remounted): nothing left to send or clear.
    setHeld(null);
    return result === "sent" ? { ok: true } : { ok: false, reason: HELD_PROMPT_UNREACHABLE };
  }

  /** Enter in an empty composer. */
  async function send(): Promise<CodeVoiceSendOutcome> {
    const current = held;
    if (!current) return { ok: true };
    if (current.place.kind === "thread") return submitToThread(current);
    setHeld(null);
    onSent?.(current.paneId, current.text);
    // The text is already in the prompt: a lone carriage return submits it, the same second write
    // a typed message ends with.
    return writeToSession(current.place.runtimeSessionId, "\r").then(
      (): CodeVoiceSendOutcome => ({ ok: true }),
      (): CodeVoiceSendOutcome => ({ ok: false, reason: HELD_PROMPT_UNREACHABLE }),
    );
  }

  /** Escape in the composer. */
  async function clear(): Promise<CodeVoiceSendOutcome> {
    const current = held;
    if (!current) return { ok: true };
    setHeld(null);
    if (current.place.kind === "thread") {
      // Only the spoken text: a draft typed in the thread before it stays.
      threadComposers?.remove(current.place.sessionId, current.text);
      return { ok: true };
    }
    try {
      for (const chunk of ptyWritesToClearHeldPrompt(current.text, current.typedInPane)) {
        await writeToSession(current.place.runtimeSessionId, chunk);
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: HELD_PROMPT_UNREACHABLE };
    }
  }

  /** A typed message for the agent holding the prompt goes after it, as one message. */
  function joins(route: ComposerRoute): boolean {
    return Boolean(held) && route.kind !== "blocked" && route.paneId === held!.paneId && samePlace(held!.place, route);
  }

  /** Send a typed message after the Held Prompt it joins. */
  async function sendJoined(text: string): Promise<CodeVoiceSendOutcome> {
    const current = held;
    if (!current) return { ok: false, reason: HELD_PROMPT_UNREACHABLE };
    if (current.place.kind === "thread") return submitToThread(current, text);
    try {
      for (const chunk of ptyWritesForMessage(` ${text.trim()}`)) await writeToSession(current.place.runtimeSessionId, chunk);
    } catch {
      return { ok: false, reason: HELD_PROMPT_UNREACHABLE };
    }
    setHeld(null);
    onSent?.(current.paneId, `${current.text} ${text.trim()}`);
    return { ok: true };
  }

  return { held, place, send, clear, joins, sendJoined };
}
