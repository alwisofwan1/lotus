import {
  CANCELLED_DELIVERY_REASON,
  EMPTY_DELIVERY_REASON,
  type VoiceAdapter,
  type VoiceDeliveryResult,
  type VoiceLiveTools,
  type VoiceTarget,
  type VoiceTurnTarget,
} from "@/modules/voice-core/voice-adapter";
import type { ComposerRoute } from "./composer-routing";
import type { PaneActivity, PaneKind } from "../types";

/**
 * The **Code Voice Adapter** (ADR-0053, plans/voice-core stories 24-27, 30): what Code mode plugs
 * into the Voice Core.
 *
 * A spoken turn to an agent — a terminal agent or a thread — becomes a **Held Prompt**: the text waits,
 * unsent, in the agent's own prompt, so the user reads it before the agent runs on it (ADR-0064). With Send Right Away on, or
 * a turn ended with ⌘Enter, it goes straight through the same composer routing a typed Enter uses —
 * to the pane that had focus when the mic opened. The text waits in the composer instead when the
 * composer already holds a message, when focus moved during the turn, or when the pane cannot take
 * unsent text (a plain shell, a thread with no input open). Whenever the text cannot reach the pane (no pane, no live session,
 * a pane that refused it) it stays in the composer with the reason: a spoken message is never dropped. Live Voice's tools act on the panes (`code-live-voice-tools.ts`).
 */

export interface CodeVoicePane {
  id: string;
  /** The name the rail and the pane header show. */
  name: string;
  kind: PaneKind;
  activity?: PaneActivity;
  /** The handle a terminal is addressed by ("Soren"), when its title says something else (ADR-0024). */
  persona?: string;
  /** False for a terminal running a plain shell: there is no agent to tell anything. */
  agent?: boolean;
  /** The agent CLI the pane runs ("Claude Code"), as the header's runner mark says. */
  runner?: string;
}

export type CodeVoiceSendOutcome = { ok: true } | { ok: false; reason: string };

export interface CodeVoiceAdapterDeps {
  /** The Composer Target right now (the focused pane), or null. */
  focused: () => VoiceTurnTarget | null;
  /** Where a message for this pane would go; null = no pane. */
  routeFor: (paneId: string | null) => ComposerRoute;
  getPanes: () => CodeVoicePane[];
  /** The composer already holds a message: held text continues it and goes where it goes. */
  composerHasText?: () => boolean;
  /** The "send right away" setting, read per turn. */
  sendRightAway: () => boolean;
  /** Put the text in the composer for the user to check and send. `spoken` is set when `text` was
   *  cleaned up automatically: the composer offers it back as Undo. `target` is set when the text is
   *  kept for a pane that no longer has focus: Enter in the composer sends it there. */
  holdInComposer: (text: string, spoken?: string, target?: VoiceTurnTarget) => void;
  /** Put the text, unsent, in the agent's own prompt (a terminal's line editor, a thread's input): a
   *  Held Prompt for `target`. Refused with a reason when that pane cannot take unsent text. `spoken`
   *  is set when `text` was cleaned up automatically (no Undo there: the composer only says so). */
  prompt: (
    text: string,
    route: Exclude<ComposerRoute, { kind: "blocked" }>,
    target: VoiceTurnTarget,
    spoken?: string,
  ) => Promise<CodeVoiceSendOutcome>;
  /** Deliver to a routable pane — the same path as a typed Enter. */
  send: (text: string, route: Exclude<ComposerRoute, { kind: "blocked" }>) => Promise<CodeVoiceSendOutcome>;
  /** Live Voice's tools on the panes (`createCodeLiveVoiceTools`). Absent = no Live Voice. */
  liveTools?: VoiceLiveTools;
}

/** Why a spoken turn waits in the composer when "send right away" is off. */
export const CODE_VOICE_REVIEW_REASON = "Check it, then press Enter to send.";

/** Why a spoken turn waits in the composer when focus moved while it was spoken. */
export function codeVoiceFocusMovedReason(spokenFor: string, movedTo: string | null): string {
  const moved = movedTo ? `you moved to ${movedTo}` : "no pane has focus now";
  return `Spoken for ${spokenFor} — ${moved}. Kept here; Enter sends to ${spokenFor}.`;
}

/** Why a turn spoken for one pane was added to a message already in the composer for another. */
export function codeVoiceAddedToMessageReason(spokenFor: string, sendsTo: string | null): string {
  const where = sendsTo ? `Enter sends it to ${sendsTo}` : "pick a pane to send it";
  return `Spoken for ${spokenFor} — added to your message; ${where}.`;
}

const COMPOSER_ROUTE = "composer";

export function createCodeVoiceAdapter(deps: CodeVoiceAdapterDeps): VoiceAdapter {
  const hold = (text: string, reason: string, target?: VoiceTurnTarget): VoiceDeliveryResult => {
    if (target) deps.holdInComposer(text, undefined, target);
    else deps.holdInComposer(text);
    return { status: "held", route: COMPOSER_ROUTE, text, reason };
  };

  return {
    async deliver(rawText, intent) {
      const text = rawText.trim();
      if (!text) return { status: "held", route: COMPOSER_ROUTE, text: "", reason: EMPTY_DELIVERY_REASON };
      if (intent.signal?.aborted) return { status: "failed", route: COMPOSER_ROUTE, text, reason: CANCELLED_DELIVERY_REASON };

      const focused = deps.focused();
      const target = intent.target === undefined ? focused : intent.target;
      // Focus moved while it was spoken: Enter in the composer would now be ambiguous, so the text
      // waits there for the pane it was meant for. A typed Enter for that held text names it again.
      if (intent.source === "voice" && target && focused?.id !== target.id) {
        if (deps.composerHasText?.()) return hold(text, codeVoiceAddedToMessageReason(target.name, focused?.name ?? null));
        return hold(text, codeVoiceFocusMovedReason(target.name, focused?.name ?? null), target);
      }
      const route = deps.routeFor(target?.id ?? null);
      if (route.kind === "blocked") return hold(text, route.reason);
      if (intent.source === "voice" && !intent.sendNow && !deps.sendRightAway()) {
        // Text already in the composer is a message being written: the turn continues it there.
        if (deps.composerHasText?.() || !target) return hold(text, CODE_VOICE_REVIEW_REASON);
        const placed = await deps.prompt(text, route, target);
        if (!placed.ok) return hold(text, placed.reason);
        return { status: "prompted", route: route.kind, text, target };
      }

      const outcome = await deps.send(text, route);
      if (!outcome.ok) return hold(text, outcome.reason);
      return { status: "sent", route: route.kind, text };
    },

    targets(): VoiceTarget[] {
      return deps.getPanes().map((pane) => ({
        id: pane.id,
        name: pane.name,
        kind: pane.kind,
        busy: pane.activity === "working",
      }));
    },

    liveTools: deps.liveTools,
  };
}
