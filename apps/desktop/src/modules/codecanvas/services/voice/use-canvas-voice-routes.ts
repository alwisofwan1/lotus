"use client";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Node } from "@xyflow/react";
import { matchLocalIntent } from "../canvas-nl-fastpath";
import { CANVAS_CREATE_NODE_KINDS } from "../commands/canvas-command";
import { agentStatusRegistry } from "../agent-status-registry";
import {
  createAgentMessagingDeps,
  sendAgentMessageTracked,
} from "../canvas-agent-messaging";
import { createCanvasCommandDeliveryEvent, type CanvasCommandDeliveryEvent } from "../canvas-command-delivery";
import type { NlModelCaller } from "../nl-model-transport";
import { getVoiceInputSettings } from "../../hooks/useVoiceInputSettings";
import type { VoiceAccuracySettings } from "../../hooks/useVoiceAccuracySettings";
import { useCanvasTerminalSubmit } from "../../hooks/useCanvasTerminalSubmit";
import { polishDictation } from "./dictation-polish";
import { buildCanvasVocabulary, canvasVoiceNodeNames } from "./canvas-vocabulary";
import { transformSelection } from "./selection-transform";
import { noteSelectionRegistry } from "./note-selection-registry";
import { voiceAgentOutputCorrelationRegistry } from "./voice-agent-output-correlation";
import { waitForClassicVoiceStage } from "./classic-voice-stage-deadline";
import { buildSttDecoderContext, LOTUS_VOICE_TERMS, resolveSttExpectedLanguages, type SttCaptureMode } from "./stt-hint";
import type { DictationDeliveryState, DictationDispatchOptions } from "./canvas-voice-adapter";
import {
  getTerminalSessionStatus,
  writeTerminalSession,
} from "@/modules/codespace/services/terminal-session-registry";

const CLASSIC_DELIVERY_RECEIPT_TIMEOUT_MS = 5_000;

type Trace = { text: string; tone: "ok" | "error" };
type ModelCall = (prompt: string, schema?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<string>;

export interface CanvasVoiceRoutesOptions {
  nodes: Node[];
  callModel?: ModelCall;
  getModelCaller: () => NlModelCaller;
  voiceAccuracy: Pick<VoiceAccuracySettings, "personalTerms" | "expectedLanguages">;
  onCommandDelivery?: (event: CanvasCommandDeliveryEvent) => void;
  setTrace: Dispatch<SetStateAction<Trace | null>>;
  setText: Dispatch<SetStateAction<string>>;
}

/**
 * The canvas routes behind the Canvas Voice Adapter: agent dictation with its write receipt, prompt
 * and terminal insert, terminal submit, note transform, plus the dictation polish and STT decoder
 * context they share. Each route reports its own outcome in the command bar.
 */
export function useCanvasVoiceRoutes({
  nodes,
  callModel,
  getModelCaller,
  voiceAccuracy,
  onCommandDelivery,
  setTrace,
  setText,
}: CanvasVoiceRoutesOptions) {
  // Shared by the voice + typed paths so speaking and typing route identically: detect a canvas-command
  // verb (fast-path, zero model), and deliver a dictation to the Focused agent.
  const hasCommandVerb = useCallback(
    (t: string) =>
      matchLocalIntent(t, {
        nodeKinds: CANVAS_CREATE_NODE_KINDS,
        agentNames: agentStatusRegistry.list().map((a) => a.name),
        frameNames: nodes.filter((n) => n.type === "frame").map((n) => String((n.data as { title?: unknown }).title ?? "")),
      }) !== null,
    [nodes],
  );
  // Polish (or pass through) a raw transcript for dictation. Shared by immediate send and the
  // review-in-bar path so both show/deliver the exact same cleaned text. Classic dictation is a
  // latency-sensitive turn: use direct HTTP when configured, but never cold-spawn a CLI utility run.
  const callDictationPolishModel = useCallback(
    (prompt: string, signal?: AbortSignal) =>
      callModel
        ? callModel(prompt, undefined, { signal })
        : getModelCaller().call(prompt, undefined, { allowCliFallback: false, signal }),
    [callModel, getModelCaller],
  );
  const buildDictationText = useCallback(
    async (rawText: string, polish: boolean, signal?: AbortSignal) => {
      if (!polish) return rawText;
      const roster = agentStatusRegistry.list();
      // Mode + live vocabulary (Option B): the active Dictation Mode shapes the cleanup, and the canvas
      // names bias correction so "Ren"/"Sora" aren't left mis-heard.
      const vocabulary = [
        ...voiceAccuracy.personalTerms,
        ...LOTUS_VOICE_TERMS,
        ...buildCanvasVocabulary({ roster, nodeNames: canvasVoiceNodeNames(nodes) }),
      ];
      return polishDictation(rawText, callDictationPolishModel, {
        mode: getVoiceInputSettings().dictationMode,
        vocabulary,
        signal,
      });
    },
    [callDictationPolishModel, nodes, voiceAccuracy.personalTerms],
  );
  const dispatchDictation = useCallback(
    async (agentId: string, agentName: string, rawText: string, opts: DictationDispatchOptions) => {
      const roster = agentStatusRegistry.list();
      const finalText = await buildDictationText(rawText, opts.polish, opts.signal);
      if (opts.signal?.aborted) return { text: finalText, delivery: "failed" as const };
      opts.onStage?.("prepared");
      opts.onStage?.("requested");
      const correlationArmed = opts.turnId
        ? voiceAgentOutputCorrelationRegistry.arm({
            agentId,
            turnId: opts.turnId,
            submittedText: finalText,
            onFirstOutput: () => opts.onAgentFirstOutput?.(),
            onTimeout: () => opts.onAgentFirstOutputTimeout?.(),
          })
        : false;
      const result = sendAgentMessageTracked(agentId, finalText, roster, createAgentMessagingDeps());
      const initialState = result.initial[0]?.state;
      if (initialState === "accepted" || initialState === "queued") opts.onStage?.(initialState);
      const preview = finalText.length > 80 ? `${finalText.slice(0, 79)}…` : finalText;
      let receipts;
      try {
        receipts = await waitForClassicVoiceStage(result.completion, {
          stage: "Agent delivery confirmation",
          timeoutMs: CLASSIC_DELIVERY_RECEIPT_TIMEOUT_MS,
          signal: opts.signal,
        });
      } catch {
        if (opts.turnId && correlationArmed) voiceAgentOutputCorrelationRegistry.cancel(opts.turnId);
        if (!opts.signal?.aborted) {
          setTrace({ text: `Delivery confirmation timed out for ${agentName} — write status is unknown.`, tone: "error" });
        }
        return { text: finalText, delivery: "failed" as const };
      }
      let delivery: DictationDeliveryState = "failed";
      if (receipts.some((receipt) => receipt.state === "written")) {
        delivery = "written";
        opts.onStage?.("written");
        if (opts.turnId) {
          if (!correlationArmed || !voiceAgentOutputCorrelationRegistry.confirmEnter(opts.turnId)) {
            opts.onAgentFirstOutputTimeout?.();
          }
        }
        onCommandDelivery?.(createCanvasCommandDeliveryEvent({
          source: "nl-command",
          targetNodeId: agentId,
          text: finalText,
          outcome: "delivered",
        }));
        setTrace({ text: `Dictated to ${agentName}: “${preview}”`, tone: "ok" });
      } else if (receipts.some((receipt) => receipt.state === "queued")) {
        delivery = "queued";
        if (opts.turnId && correlationArmed) voiceAgentOutputCorrelationRegistry.cancel(opts.turnId);
        onCommandDelivery?.(createCanvasCommandDeliveryEvent({
          source: "nl-command",
          targetNodeId: agentId,
          text: finalText,
          outcome: "queued",
        }));
        setTrace({ text: `Dictated to ${agentName} (queued): “${preview}”`, tone: "ok" });
      } else {
        if (opts.turnId && correlationArmed) voiceAgentOutputCorrelationRegistry.cancel(opts.turnId);
        setTrace({ text: `${agentName} isn't running yet — launch it first.`, tone: "error" });
      }
      return { text: finalText, delivery };
    },
    [buildDictationText, onCommandDelivery, setTrace],
  );

  /** Raw input for an agent's prompt — a lone Enter, a line-kill — never trimmed or framed. False when
   *  the node has no live PTY prompt. */
  const writeAgentPrompt = useCallback((agentId: string, data: string) => {
    const handle = createAgentMessagingDeps().getHandle(agentId);
    // Needs a writable prompt now, as insertAgentMessage does: a PTY that is restarting takes nothing.
    if (!handle?.insert || !handle.canReply()) return false;
    handle.insert(data);
    return true;
  }, []);

  const insertTerminalDictation = useCallback((nodeId: string, draft: string) => {
    const terminal = nodes.find((node) => node.id === nodeId && node.type === "terminal");
    if (!terminal) return false;
    const runtimePaneId = (terminal.data as { runtimePaneId?: unknown } | undefined)?.runtimePaneId;
    const paneId = typeof runtimePaneId === "string" && runtimePaneId ? runtimePaneId : nodeId;
    const status = getTerminalSessionStatus(paneId);
    if (status !== "live" && status !== "detached") return false;
    writeTerminalSession(paneId, draft);
    return true;
  }, [nodes]);

  // Rewrite the selected text in a focused note per the spoken/typed instruction (Option D). Fails
  // closed — a model error leaves the selection untouched and says so.
  const runTransform = useCallback(
    async (nodeId: string, instruction: string, selection: string, signal?: AbortSignal) => {
      const handle = noteSelectionRegistry.get(nodeId);
      if (!handle) {
        setTrace({ text: "Select text in a note to transform it.", tone: "error" });
        return false;
      }
      const model = callModel ?? getModelCaller().call;
      const result = await transformSelection(selection, instruction, (prompt) => model(prompt, undefined, signal ? { signal } : undefined));
      // A cancelled or superseded turn must never rewrite the note after the fact.
      if (signal?.aborted) return false;
      if (result === null) {
        setTrace({ text: "Couldn't transform that — selection left unchanged.", tone: "error" });
        return false;
      }
      handle.replaceSelection(result);
      const preview = result.length > 60 ? `${result.slice(0, 59)}…` : result;
      setTrace({ text: `Transformed selection: “${preview}”`, tone: "ok" });
      return true;
    },
    [callModel, getModelCaller, setTrace],
  );

  const submitTerminal = useCanvasTerminalSubmit({
    nodes,
    onCommandDelivery,
    setText,
    setTrace,
  });


  // Push-to-talk voice input (STT): click to record, click again to transcribe + run. Same NL
  // pipeline as typing — the transcript goes straight through submitQuery (fast path → LLM fallback).
  // Decoder context is snapshotted when capture starts. Only an explicit Command capture receives the
  // command grammar; Auto/Dictate stay neutral so noisy free speech is not pulled toward Canvas verbs.
  const getDecoderContext = useCallback((mode: SttCaptureMode) => {
    const vocabulary = buildCanvasVocabulary({
      roster: agentStatusRegistry.list(),
      nodeNames: canvasVoiceNodeNames(nodes),
    });
    return buildSttDecoderContext(mode, {
      personalTerms: voiceAccuracy.personalTerms,
      canvasTerms: vocabulary,
      // Explicit Voice settings win. Otherwise use one conservative device-locale language so a
      // monolingual turn cannot silently become a fluent translation into an unrelated language.
      expectedLanguages: resolveSttExpectedLanguages(voiceAccuracy.expectedLanguages),
    });
  }, [nodes, voiceAccuracy.expectedLanguages, voiceAccuracy.personalTerms]);

  return {
    hasCommandVerb,
    buildDictationText,
    dispatchDictation,
    writeAgentPrompt,
    insertTerminalDictation,
    runTransform,
    submitTerminal,
    getDecoderContext,
  };
}
