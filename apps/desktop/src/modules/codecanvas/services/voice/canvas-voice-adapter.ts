import type { Node } from "@xyflow/react";
import {
  CANCELLED_DELIVERY_REASON,
  EMPTY_DELIVERY_REASON,
  type VoiceAdapter,
  type VoiceDeliveryIntent,
  type VoiceDeliveryResult,
  type VoiceLiveTools,
  type VoiceTarget,
  type VoiceTurnTarget,
} from "@/modules/voice-core/voice-adapter";
import type { AgentStatusSnapshot } from "../agent-status-registry";
import { buildNodeIndex } from "../canvas-nl-command";
import { resolveAddressedCanvasTerminalText } from "../terminal/canvas-terminal-delivery";
import { resolveVoiceOutcome, type VoiceOutcome } from "./voice-intent-router";
import { buildCanvasVoiceContextFromNodes } from "./canvas-voice-node-context";
import type { CanvasVoiceContext } from "./canvas-voice-context";
import type { VoiceInputSettings } from "./voice-mode";
import type { VoiceTurnDelivery, VoiceTurnMilestoneName } from "./voice-turn-diagnostics";

export type DictationDispatchStage = "prepared" | "requested" | "accepted" | "queued" | "written";
export type DictationDeliveryState = VoiceTurnDelivery;

export interface DictationDispatchOptions {
  polish: boolean;
  /** Local-only voice turn correlation; never exported through support diagnostics. */
  turnId?: string;
  /** Cancels pre-delivery polish/routing waits; it cannot retract an Enter already written. */
  signal?: AbortSignal;
  onStage?: (stage: DictationDispatchStage) => void;
  onAgentFirstOutput?: () => void;
  onAgentFirstOutputTimeout?: () => void;
}

export interface DictationDispatchResult {
  text: string;
  delivery: DictationDeliveryState;
}

type Trace = { text: string; tone: "ok" | "error" };

/** Where a routed canvas utterance can go. Each route reports its own outcome in the bar. */
export interface CanvasVoiceRoutes {
  /** Run text through the NL command pipeline. False when it could not carry the command out. */
  command: (text: string, options: { input: "typed" | "voice"; signal?: AbortSignal }) => Promise<boolean>;
  /** Write a prompt to an agent and wait for its receipt. */
  dictate: (agentId: string, agentName: string, text: string, options: DictationDispatchOptions) => Promise<DictationDispatchResult>;
  /** Type text into a live agent prompt without submitting it: a Held Prompt. Refused, with a reason
   *  when there is one to give, when that prompt cannot take unsent text now (offline, headless). */
  insertAgent: (agentId: string, agentName: string, text: string) => { ok: true } | { ok: false; reason?: string };
  /** Type text into a plain Terminal node without submitting it. */
  insertTerminal: (nodeId: string, text: string) => boolean;
  /** Submit text to a plain Terminal node. Resolves true once its receipt says written. */
  submitTerminal: (nodeId: string, nodeName: string, text: string, options: { signal?: AbortSignal }) => Promise<boolean>;
  /** Rewrite a note selection. Resolves true when the note changed. */
  transform: (nodeId: string, instruction: string, selection: string, signal?: AbortSignal) => Promise<boolean>;
}

/** The command bar surface the adapter writes to. */
export interface CanvasVoiceUi {
  /** Replace the input text, or update it from its current value. */
  setText: (text: string | ((current: string) => string)) => void;
  focusInput: () => void;
  setTrace: (trace: Trace) => void;
  /** The bar already holds typed text: a spoken message continues it there. */
  hasText: () => boolean;
  /** Text kept in the bar for the node it was spoken to, which no longer has focus: the next typed
   *  Enter sends it there. Null lets go. */
  keepFor: (target: VoiceTurnTarget | null) => void;
  /** Barge-in: the user took the floor, so in-flight speech stops. */
  interruptSpeech: () => void;
}

export interface CanvasVoiceAdapterDeps {
  getNodes: () => Node[];
  getRoster: () => AgentStatusSnapshot[];
  getInputSettings: () => VoiceInputSettings;
  hasCommandVerb: (text: string) => boolean;
  routes: CanvasVoiceRoutes;
  ui: CanvasVoiceUi;
  liveTools?: VoiceLiveTools;
}

/** Push-to-Talk bookkeeping a spoken turn hands the adapter, so its diagnostics stay complete. */
export interface CanvasVoiceTurnObserver {
  turnId: string;
  mark: (milestone: VoiceTurnMilestoneName) => void;
  /** Record the turn diagnostic with the text that was actually delivered or held. */
  record: (finalText: string, polishedText?: string, delivery?: DictationDeliveryState) => void;
  /** Stage callbacks for an auto-sent dictation. */
  dictation?: Pick<DictationDispatchOptions, "onStage" | "onAgentFirstOutput" | "onAgentFirstOutputTimeout">;
}

export interface CanvasVoiceDeliveryIntent extends VoiceDeliveryIntent {
  /** Canvas Voice Context snapshotted when the mic opened; default = the board right now. */
  voiceContext?: CanvasVoiceContext;
  /** Rewrites routed dictation text: the optional automatic cleanup, then the "after-ai" replacements. */
  rewriteDictation?: (text: string, signal?: AbortSignal) => string | Promise<string>;
  /** Called once the route is known, before anything is delivered. */
  onRouted?: (outcome: VoiceOutcome) => void;
  turn?: CanvasVoiceTurnObserver;
}

export type CanvasVoiceDeliveryResult = VoiceDeliveryResult & { delivery?: DictationDeliveryState };

/** Why a spoken message waits in the bar when its agent's prompt could not take it. */
export function canvasCannotTakeUnsentReason(agentName: string): string {
  return `${agentName} can't take text in its prompt right now — check it here, then press Enter to send.`;
}

/** Why a spoken message waits in the bar, added to a message the user was already typing. */
export const CANVAS_ADDED_TO_MESSAGE_REASON = "Added to your message — check it, then press Enter.";

/** Why a spoken turn waits in the bar when the focus moved while it was spoken. */
export function canvasFocusMovedReason(spokenFor: string, movedTo: string | null): string {
  const moved = movedTo ? `you moved to ${movedTo}` : "nothing is selected now";
  return `Spoken for ${spokenFor} — ${moved}. Kept here; Enter sends to ${spokenFor}.`;
}

/** Outcomes that go to one node, and so to the node the turn was spoken to. */
const TARGETED_OUTCOMES = new Set<VoiceOutcome["kind"]>(["dictate", "terminal-submit", "terminal-insert", "transform"]);

/** Settings a typed Enter uses: an explicit submit never holds for review. */
const TYPED_SETTINGS: Partial<VoiceInputSettings> = { autoSubmit: true, minWordsToSubmit: 0, sendRightAway: true };

const sent = (route: string, text: string): CanvasVoiceDeliveryResult => ({ status: "sent", route, text });
const held = (route: string, text: string, reason: string): CanvasVoiceDeliveryResult => ({ status: "held", route, text, reason });
const failed = (route: string, text: string, reason: string): CanvasVoiceDeliveryResult => ({ status: "failed", route, text, reason });
const commandResult = (text: string, ok: boolean): CanvasVoiceDeliveryResult =>
  ok ? sent("command", text) : failed("command", text, "the command did not run");

/**
 * The Canvas Voice Adapter (ADR-0053): the one place canvas decides where a typed or spoken
 * utterance goes. It runs the Voice Intent Router on the Canvas Voice Context and carries out the
 * outcome through the canvas routes (NL pipeline, agent dictation, terminal, note transform).
 * Live Voice tools come from the Live Voice controller and are exposed as `liveTools`.
 */
export type CanvasVoiceAdapter = Omit<VoiceAdapter, "deliver"> & {
  deliver: (text: string, intent: CanvasVoiceDeliveryIntent) => Promise<CanvasVoiceDeliveryResult>;
};

export function createCanvasVoiceAdapter(deps: CanvasVoiceAdapterDeps): CanvasVoiceAdapter {
  const { routes, ui } = deps;

  const focusNow = (): VoiceTurnTarget | null => {
    const focus = buildCanvasVoiceContextFromNodes(deps.getNodes(), deps.getRoster()).focus;
    return focus ? { id: focus.nodeId, name: focus.name } : null;
  };
  /** The board as it is, but with `target` as the one Focused Node: where a locked turn goes. */
  const contextFor = (target: VoiceTurnTarget | null | undefined): CanvasVoiceContext => {
    return buildCanvasVoiceContextFromNodes(deps.getNodes(), deps.getRoster(), target);
  };
  /** Keep the text in the bar, after anything already typed there, with the reason. */
  const holdInBar = (text: string, reason: string, target?: VoiceTurnTarget): CanvasVoiceDeliveryResult => {
    // Text already in the bar keeps the node it was kept for: an added turn joins that message.
    if (!ui.hasText()) ui.keepFor(target ?? null);
    ui.setText((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
    ui.focusInput();
    ui.setTrace({ text: reason, tone: "error" });
    return held("composer", text, reason);
  };

  const deliverTyped = async (q: string, intent: CanvasVoiceDeliveryIntent): Promise<CanvasVoiceDeliveryResult> => {
    const { signal } = intent;
    const nodes = deps.getNodes();
    const addressedTerminal = resolveAddressedCanvasTerminalText(q, nodes);
    if (addressedTerminal) {
      ui.interruptSpeech();
      const delivery = routes.submitTerminal(addressedTerminal.nodeId, addressedTerminal.nodeName, addressedTerminal.text, { signal });
      ui.setText("");
      return (await delivery)
        ? sent("terminal-submit", addressedTerminal.text)
        : failed("terminal-submit", addressedTerminal.text, `${addressedTerminal.nodeName} did not receive it`);
    }
    const outcome = resolveVoiceOutcome(
      q,
      // Text kept for the node it was spoken to goes there, wherever the focus is now.
      intent.voiceContext ?? contextFor(intent.target),
      { ...deps.getInputSettings(), ...TYPED_SETTINGS },
      { hasCommandVerb: deps.hasCommandVerb },
      intent.forced,
    );
    intent.onRouted?.(outcome);
    switch (outcome.kind) {
      case "dictate": {
        ui.interruptSpeech();
        const delivery = routes.dictate(outcome.agentId, outcome.agentName, outcome.text, { polish: false, signal });
        ui.setText("");
        const result = await delivery;
        return result.delivery === "failed"
          ? { ...failed("dictate", result.text, `${outcome.agentName} did not receive it`), delivery: result.delivery }
          : { ...sent("dictate", result.text), delivery: result.delivery };
      }
      case "terminal-submit":
      case "terminal-insert": {
        ui.interruptSpeech();
        const delivery = routes.submitTerminal(outcome.nodeId, outcome.nodeName, outcome.text, { signal });
        ui.setText("");
        return (await delivery)
          ? sent("terminal-submit", outcome.text)
          : failed("terminal-submit", outcome.text, `${outcome.nodeName} did not receive it`);
      }
      case "transform": {
        const delivery = routes.transform(outcome.nodeId, outcome.instruction, outcome.selection, signal);
        ui.setText("");
        return (await delivery)
          ? sent("transform", outcome.instruction)
          : failed("transform", outcome.instruction, "the selection was left unchanged");
      }
      case "insert":
        // The planner owns the deterministic no-agent error for repository work; it calls no model.
        return commandResult(q, await routes.command(q, { input: "typed", signal }));
      case "command":
        return commandResult(outcome.text, await routes.command(outcome.text, { input: "typed", signal }));
      case "ignore":
        return held("ignore", q, EMPTY_DELIVERY_REASON);
    }
  };

  const deliverVoice = async (transcript: string, intent: CanvasVoiceDeliveryIntent): Promise<CanvasVoiceDeliveryResult> => {
    const { signal, turn } = intent;
    const mark = (name: VoiceTurnMilestoneName) => turn?.mark(name);
    const record = (finalText: string, polishedText?: string, delivery?: DictationDeliveryState) =>
      turn?.record(finalText, polishedText, delivery);
    // Routed against the node that had focus when the mic opened (ADR-0064), never today's focus.
    const settings = deps.getInputSettings();
    const outcome = resolveVoiceOutcome(
      transcript,
      intent.voiceContext ?? contextFor(intent.target),
      intent.sendNow ? { ...settings, sendRightAway: true } : settings,
      { hasCommandVerb: deps.hasCommandVerb },
      intent.forced,
    );
    if (intent.rewriteDictation && (outcome.kind === "dictate" || outcome.kind === "terminal-insert" || outcome.kind === "insert")) {
      // Stays synchronous when there is nothing to wait for (no cleanup), so routing timing is unchanged.
      const rewritten = intent.rewriteDictation(outcome.text, signal);
      outcome.text = typeof rewritten === "string" ? rewritten : await rewritten;
    }
    intent.onRouted?.(outcome);
    mark("route_resolved");

    // The focus moved while it was spoken: Enter would now be ambiguous, so a turn meant for one node
    // waits in the bar for that node. A command for the canvas runs regardless.
    const spokenFor = intent.target;
    if (spokenFor && TARGETED_OUTCOMES.has(outcome.kind)) {
      const now = focusNow();
      if (now?.id !== spokenFor.id) {
        const text = outcome.kind === "transform" ? outcome.instruction : "text" in outcome ? outcome.text : transcript;
        record(text);
        return holdInBar(text, canvasFocusMovedReason(spokenFor.name, now?.name ?? null), spokenFor);
      }
    }

    switch (outcome.kind) {
      case "command": {
        ui.setText(outcome.text);
        const submitted = routes.command(outcome.text, { input: "voice", signal });
        mark("command_submitted");
        mark("turn_complete");
        record(outcome.text);
        // Awaited so the session stays in flight until the command settles: a second submit is
        // refused meanwhile, and a new recording aborts this one through the signal.
        return commandResult(outcome.text, await submitted);
      }
      case "dictate": {
        if (outcome.autoSend) {
          const result = await routes.dictate(outcome.agentId, outcome.agentName, outcome.text, {
            polish: false,
            turnId: turn?.turnId,
            signal,
            ...turn?.dictation,
          });
          if (signal?.aborted) return failed("dictate", result.text, CANCELLED_DELIVERY_REASON);
          return result.delivery === "failed"
            ? { ...failed("dictate", result.text, `${outcome.agentName} did not receive it`), delivery: result.delivery }
            : { ...sent("dictate", result.text), delivery: result.delivery };
        }
        // A **Held Prompt** (ADR-0064): the text waits, unsent, in the agent's own prompt; Enter in the
        // empty bar sends it. It waits in the bar instead when the bar already holds a message, or
        // when the agent's prompt cannot take unsent text (offline, headless).
        mark("held_for_review");
        mark("turn_complete");
        record(outcome.text);
        if (ui.hasText()) return holdInBar(outcome.text, CANVAS_ADDED_TO_MESSAGE_REASON);
        const placed = routes.insertAgent(outcome.agentId, outcome.agentName, outcome.text);
        // Kept for this agent: Enter in the bar sends it there, even after the focus moves on.
        if (!placed.ok) {
          const reason = placed.reason ?? canvasCannotTakeUnsentReason(outcome.agentName);
          return holdInBar(outcome.text, reason, { id: outcome.agentId, name: outcome.agentName });
        }
        ui.keepFor(null);
        ui.focusInput();
        return { status: "prompted", route: "dictate", text: outcome.text, target: { id: outcome.agentId, name: outcome.agentName } };
      }
      case "terminal-submit": {
        mark("delivery_requested");
        record(outcome.text);
        const ok = await routes.submitTerminal(outcome.nodeId, outcome.nodeName, outcome.text, { signal });
        if (signal?.aborted) return failed("terminal-submit", outcome.text, CANCELLED_DELIVERY_REASON);
        mark("turn_complete");
        return ok ? sent("terminal-submit", outcome.text) : failed("terminal-submit", outcome.text, `${outcome.nodeName} did not receive it`);
      }
      case "terminal-insert": {
        const inserted = routes.insertTerminal(outcome.nodeId, outcome.text);
        mark("held_for_review");
        mark("turn_complete");
        record(outcome.text);
        if (inserted) {
          ui.setTrace({ text: `Dictation inserted in ${outcome.nodeName}. Review it there, then press Enter.`, tone: "ok" });
          return held("terminal-insert", outcome.text, `review in ${outcome.nodeName}`);
        }
        ui.setText(outcome.text);
        ui.focusInput();
        ui.setTrace({ text: `${outcome.nodeName} is not writable yet. Dictation kept in the command field.`, tone: "error" });
        return held("terminal-insert", outcome.text, `${outcome.nodeName} is not writable yet`);
      }
      case "transform": {
        record(outcome.instruction);
        const ok = await routes.transform(outcome.nodeId, outcome.instruction, outcome.selection, signal);
        return ok ? sent("transform", outcome.instruction) : failed("transform", outcome.instruction, "the selection was left unchanged");
      }
      case "insert": {
        record(outcome.text);
        ui.focusInput();
        if (outcome.reason === "no-dictate-target") {
          ui.setText(outcome.text);
          ui.setTrace({ text: "Select a coding agent to receive this dictation — text kept for review.", tone: "error" });
          return held("insert", outcome.text, "no agent selected");
        }
        if (outcome.reason === "repository-needs-agent") {
          ui.setText(outcome.text);
          ui.setTrace({ text: "Select a coding agent to analyze this repository — request kept for review.", tone: "error" });
          return held("insert", outcome.text, "repository work needs an agent");
        }
        ui.setText((prev) => (prev.trim() ? `${prev.trim()} ${outcome.text}` : outcome.text));
        return held("insert", outcome.text, "too short to run");
      }
      case "ignore":
        record("");
        ui.setTrace({ text: "Didn't catch that — try again.", tone: "error" });
        return held("ignore", transcript, EMPTY_DELIVERY_REASON);
    }
  };

  return {
    async deliver(text, intent) {
      const q = text.trim();
      if (!q) return held("ignore", text, EMPTY_DELIVERY_REASON);
      if (intent.signal?.aborted) return failed("cancelled", q, CANCELLED_DELIVERY_REASON);
      const result = intent.source === "typed" ? await deliverTyped(q, intent) : await deliverVoice(q, intent);
      return intent.signal?.aborted && result.status === "sent"
        ? failed(result.route, result.text, CANCELLED_DELIVERY_REASON)
        : result;
    },
    targets(): VoiceTarget[] {
      const roster = deps.getRoster();
      const agentIds = new Set(roster.map((agent) => agent.id));
      const agents = roster.map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: "agent",
        busy: agent.status === "running" || agent.status === "connecting",
      }));
      const terminals = buildNodeIndex(deps.getNodes())
        .filter((ref) => ref.kind === "terminal" && !agentIds.has(ref.id) && ref.name)
        .map((ref) => ({ id: ref.id, name: ref.name, kind: "terminal" }));
      return [...agents, ...terminals];
    },
    liveTools: deps.liveTools,
  };
}
