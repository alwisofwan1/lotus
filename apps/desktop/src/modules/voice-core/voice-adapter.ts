/**
 * The Voice Adapter — what one mode plugs into the Voice Core (ADR-0053, plans/voice-core).
 *
 * It answers three things only: where a finished utterance goes (`deliver`), which targets exist
 * (`targets`), and which tools Live Voice may call (`liveTools`, absent = the mode has no Live Voice).
 * One adapter per mode; every adapter passes the same contract suite
 * (`testing/voice-adapter-contract.ts`).
 */

/** Typed Enter or a spoken Push-to-Talk turn. */
export type VoiceDeliverySource = "typed" | "voice";

/** Explicit one-turn override from a hotkey; absent = Auto (the adapter decides). */
export type VoiceForcedMode = "command" | "dictate";

/** The **Composer Target** a Push-to-Talk turn was spoken to: captured when the mic opened. */
export interface VoiceTurnTarget {
  id: string;
  /** Display name, for the reason a turn was kept. */
  name: string;
}

export interface VoiceDeliveryIntent {
  source: VoiceDeliverySource;
  forced?: VoiceForcedMode;
  /**
   * Where Enter would have gone when the mic opened (ADR-0064). A spoken turn goes there, never to
   * whatever has focus when the transcript arrives. Absent = the adapter uses the current target
   * (a typed Enter); null = nothing was targeted when the mic opened.
   */
  target?: VoiceTurnTarget | null;
  /** The turn was ended with ⌘Enter: send it now, whatever Send Right Away says. */
  sendNow?: boolean;
  /** The turn's signal. Aborted = the turn was cancelled or superseded: nothing may apply. */
  signal?: AbortSignal;
}

/**
 * - `sent` — the text reached its destination (a command ran, a prompt was written or queued).
 * - `prompted` — a **Held Prompt**: the text waits, unsent, in `target`'s own prompt (ADR-0064).
 * - `held` — the text waits in the composer (or a review draft) for the user, with the reason.
 * - `failed` — nothing was delivered; `reason` says why.
 *
 * `route` names the path the adapter chose (mode-specific, e.g. "command", "dictate").
 * `text` is the text that was delivered or held, after any adapter rewrite.
 */
export type VoiceDeliveryResult =
  | { status: "sent"; route: string; text: string }
  | { status: "prompted"; route: string; text: string; target: VoiceTurnTarget }
  | { status: "held"; route: string; text: string; reason: string }
  | { status: "failed"; route: string; text: string; reason: string };

/** An addressable agent or pane, for callouts and name resolution. */
export interface VoiceTarget {
  id: string;
  /** Display name, the one a user says ("Rowan"). */
  name: string;
  /** Mode-specific kind, e.g. "agent" or "terminal". */
  kind: string;
  /** True while the target is working on a turn. */
  busy?: boolean;
}

/** A Live Voice tool, in the OpenAI-Realtime `session.update.tools` schema. */
export interface VoiceLiveTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface VoiceLiveToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceLiveTools {
  instructions: string;
  tools: readonly VoiceLiveTool[];
  /** Runs one tool call. Never throws: an unknown or failing call resolves to an error result. */
  execute: (call: VoiceLiveToolCall) => Promise<unknown>;
}

export interface VoiceAdapter {
  deliver: (text: string, intent: VoiceDeliveryIntent) => Promise<VoiceDeliveryResult>;
  targets: () => VoiceTarget[];
  liveTools?: VoiceLiveTools;
}

/** Result for an aborted turn: nothing was applied. */
export const CANCELLED_DELIVERY_REASON = "cancelled";
/** Result for empty text: nothing to deliver. */
export const EMPTY_DELIVERY_REASON = "empty";
