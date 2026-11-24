import {
  CANCELLED_DELIVERY_REASON,
  EMPTY_DELIVERY_REASON,
  type VoiceAdapter,
  type VoiceTurnTarget,
} from "@/modules/voice-core/voice-adapter";

/**
 * The **Chat Voice Adapter** (ADR-0064, plans/voice-core story 57). In Chat the composer IS the
 * thread's input, so a spoken turn is already "in the agent's prompt": it goes in at the caret,
 * unsent, and waits for Enter. ⌘Enter on the turn, or Send Right Away, sends it at once.
 *
 * No locked-target rule: the composer is keyed by thread, so switching threads unmounts it and
 * the Voice Core cancels the turn (mic released, nothing applied).
 */

/** Why a spoken turn waits in the composer. */
export const CHAT_VOICE_REVIEW_REASON = "Check it, then press Enter to send.";
/** Why a turn that should have been sent still waits (a request is open, or a send is in flight). */
export const CHAT_VOICE_NOT_SENT_REASON = "It could not be sent yet, so it is in the box.";

export interface ChatVoiceDeps {
  /** The thread this composer writes to. */
  thread: VoiceTurnTarget;
  /** Put the text in at the caret, unsent. */
  insert: (text: string) => void;
  /** Send what the composer holds. False = nothing was sent (a request is open, a send is in flight). */
  send: () => boolean;
  /** The Send Right Away setting, read per turn. */
  sendRightAway: () => boolean;
}

export function createChatVoiceAdapter(deps: ChatVoiceDeps): VoiceAdapter {
  return {
    targets: () => [{ id: deps.thread.id, name: deps.thread.name, kind: "thread" }],
    async deliver(text, intent) {
      const spoken = text.trim();
      if (!spoken) return { status: "held", route: "composer", text: "", reason: EMPTY_DELIVERY_REASON };
      if (intent.signal?.aborted) return { status: "failed", route: "composer", text: spoken, reason: CANCELLED_DELIVERY_REASON };
      deps.insert(spoken);
      // A typed Enter is a send by definition; a spoken turn only when asked to.
      const now = intent.source === "typed" || intent.sendNow === true || deps.sendRightAway();
      if (!now) return { status: "held", route: "composer", text: spoken, reason: CHAT_VOICE_REVIEW_REASON };
      return deps.send()
        ? { status: "sent", route: "thread", text: spoken }
        : { status: "held", route: "composer", text: spoken, reason: CHAT_VOICE_NOT_SENT_REASON };
    },
  };
}

/**
 * Spoken text as it joins what is already before the caret: a space when the two would touch, and a
 * capital when it starts a sentence. Never lowercases: the recogniser's capitals may be names.
 */
export function joinDictation(before: string, spoken: string): string {
  const text = spoken.trim();
  if (!text) return "";
  const startsSentence = before.trim() === "" || /[.!?。！？]\s*$/.test(before);
  const head = startsSentence ? text[0].toUpperCase() + text.slice(1) : text;
  // Japanese and Chinese put no space between sentences or words; after Latin text a space reads right.
  const unspaced = NO_SPACE_SCRIPT.test(before.slice(-1));
  return before === "" || /\s$/.test(before) || unspaced ? head : ` ${head}`;
}

/** Han, kana, and their punctuation and full-width forms. Hangul is left out: Korean uses spaces. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;
