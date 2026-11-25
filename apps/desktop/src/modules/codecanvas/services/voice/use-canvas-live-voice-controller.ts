"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { useTtsProviderRegistry } from "@/lib/hooks/useTtsProviderRegistry";
import { currentNamePool } from "@/lib/agent-naming";
import { S2S_LIVE_VOICE_END_POLICY } from "./s2s-auto-end-policy";
import { agentStatusRegistry } from "../agent-status-registry";
import {
  createAgentMessagingDeps,
  sendAgentMessageTracked,
  type AgentMessageDeliveryReceipt,
} from "../canvas-agent-messaging";
import { createCanvasCommandDeliveryEvents, type CanvasCommandDeliveryEvent } from "../canvas-command-delivery";
import { gatherDispatchWorkspaceContext } from "../canvas-dispatch-context";
import { hasVagueReference } from "../refine-dispatch-prompt";
import type { CanvasCommand, CanvasCommandResult } from "../commands/canvas-command";
import { CANVAS_CREATE_NODE_KINDS } from "../commands/canvas-command";
import type { AppCommand, CanvasProjectRef } from "../canvas-nl-command";
import { buildS2sCanvasInstructions } from "./s2s-canvas-instructions";
import { bundledPersonaSource, loadPersona, personaNameForTone } from "./persona/canvas-persona";
import { compileAgentDelegation } from "./agent-delegation-compiler";
import {
  composeVoiceDispatchPromptDetailed,
  shouldComposeVoicePrompt,
  stripLeadingAddressingFrame,
} from "./voice-dispatch-compose";
import { buildCanvasVocabulary } from "./canvas-vocabulary";
import { buildS2sCanvasLiveVoiceContext } from "./s2s-canvas-live-context";
import {
  buildS2sCanvasRealtimeTools,
  executeS2sCanvasToolCall,
  resolveSocialAgentMessage,
  type S2sCanvasToolResult,
} from "./s2s-canvas-tool-executor";
import { buildS2sInfoTools, executeS2sInfoToolCall, isS2sInfoTool } from "./s2s-canvas-info-tools";
import { codecanvasMemorySearch, codecanvasMemoryWrite } from "@/lib/tauri/codecanvas";
import { getPersistentPtyTranscript } from "@/lib/pty-session-pool";
import { useCommandBarLiveVoice, type CommandBarLiveVoice } from "./use-command-bar-live-voice";
import type { VoiceLiveTools } from "@/modules/voice-core/voice-adapter";
import type { LiveVoiceStripState } from "@/modules/voice-core/live-voice-strip";
import { useLiveVoiceStripRecorder } from "./use-live-voice-strip-recorder";
import { copyS2sVoiceDiagnostics } from "./s2s-voice-diagnostics-copy";
import { recordS2sVoiceDiagnostic } from "./s2s-voice-diagnostics";
import { buildS2sVoiceContextKey } from "./s2s-voice-context-version";
import { applyS2sVoiceDialogueMemory, recordS2sVoiceDialogueTurn, type S2sVoiceDialogueState } from "./s2s-voice-dialogue-state";
import { S2S_CLARIFICATION_TTL_MS, recordS2sPendingClarification, resolveS2sClarificationCall, type S2sVoiceClarificationState } from "./s2s-voice-clarification";
import { buildVoiceToolTraceEntry, isVoiceToolTraceEnabled, type VoiceToolTraceEntry } from "./s2s-voice-tool-trace";
import {
  createS2sTranscriptWaitQueue,
  S2S_TRANSCRIPT_MAX_WAIT_MS,
} from "./s2s-transcript-wait-queue";
import {
  appendFinalUserTranscript,
  authoritativeUserTranscript,
  consumeUserTranscript,
  initialS2sUserTranscriptBuffer,
  markAgentAudioStarted,
  markAgentReplied,
  type S2sUserTranscriptBuffer,
} from "./s2s-user-transcript-buffer";

export type CanvasLiveVoiceTrace = { text: string; tone: "ok" | "error" };

/** Compatibility export for tests/callers that need the adaptive wait's hard upper bound. */
export const S2S_TRANSCRIPT_GRACE_MS = S2S_TRANSCRIPT_MAX_WAIT_MS;

export interface CanvasLiveVoiceControllerOptions {
  nodes: Node[];
  cwd: string;
  projectName?: string | null;
  callModel?: (prompt: string) => Promise<string>;
  projects?: CanvasProjectRef[];
  activeProjectId?: string;
  previousProjectId?: string;
  runCommand: (command: CanvasCommand) => CanvasCommandResult | void;
  runApp: (command: AppCommand) => boolean;
  onCommandDelivery?: (event: CanvasCommandDeliveryEvent) => void;
  setTrace: (trace: CanvasLiveVoiceTrace) => void;
}

export interface CanvasLiveVoiceController {
  live: CommandBarLiveVoice;
  /** The conversation so far, for the strip above the composer. Starts empty with each session. */
  strip: LiveVoiceStripState;
  /** The canvas Live Voice tools: what the session advertises and the executor it calls. */
  liveTools: VoiceLiveTools;
  voiceToolTrace: VoiceToolTraceEntry | null;
  voiceDiagnosticsCopyState: "idle" | "copied" | "empty" | "failed";
  copyVoiceDiagnostics: () => Promise<void>;
}

export function useCanvasLiveVoiceController({
  nodes,
  cwd,
  projectName,
  callModel,
  projects,
  activeProjectId,
  previousProjectId,
  runCommand,
  runApp,
  onCommandDelivery,
  setTrace,
}: CanvasLiveVoiceControllerOptions): CanvasLiveVoiceController {
  const [voiceToolTrace, setVoiceToolTrace] = useState<VoiceToolTraceEntry | null>(null);
  const [voiceDiagnosticsCopyState, setVoiceDiagnosticsCopyState] = useState<"idle" | "copied" | "empty" | "failed">("idle");
  const dialogueRef = useRef<S2sVoiceDialogueState>({});
  const clarificationRef = useRef<S2sVoiceClarificationState>({});
  const bufferRef = useRef<S2sUserTranscriptBuffer>(initialS2sUserTranscriptBuffer());
  // Tool calls often race final STT. A short initial wait extends only while partial transcription
  // is actively progressing, bounded by the hard grace cap.
  const transcriptWaitQueueRef = useRef(createS2sTranscriptWaitQueue());
  const [hasPendingClarification, setHasPendingClarification] = useState(false);
  const [contextVersion, setContextVersion] = useState(1);
  const contextKeyRef = useRef<string | null>(null);

  const { registry: ttsRegistry } = useTtsProviderRegistry();
  const responseVerbosity = ttsRegistry?.output?.verbosity ?? "normal";
  // Settings → Voice → Speak style picks the register the concierge speaks in. Resolved from the
  // bundled persona set; a raw/unknown name yields an empty body and the section is omitted.
  const personaBody = loadPersona(
    personaNameForTone(ttsRegistry?.output?.tone),
    [bundledPersonaSource()],
  ).body;

  const liveVoiceContext = useMemo(
    () => buildS2sCanvasLiveVoiceContext(nodes, agentStatusRegistry.list()),
    [nodes],
  );
  const contextKey = useMemo(() => buildS2sVoiceContextKey(liveVoiceContext), [liveVoiceContext]);
  useEffect(() => {
    if (contextKeyRef.current === contextKey) return;
    setContextVersion((prev) => (contextKeyRef.current === null ? prev : prev + 1));
    contextKeyRef.current = contextKey;
  }, [contextKey]);

  const realtimeTools = useMemo(() => {
    const toolCtx = {
      nodeKinds: CANVAS_CREATE_NODE_KINDS,
      agentNames: liveVoiceContext.agentNames,
      agentTargetHints: liveVoiceContext.agentTargetHints,
      projectNames: projects?.map((project) => project.name),
      hasBrowserNodes: liveVoiceContext.hasBrowserNodes,
      hasProjectMemory: !!activeProjectId,
      hasPendingClarification,
    };
    return [...buildS2sCanvasRealtimeTools(toolCtx), ...buildS2sInfoTools(toolCtx)];
  }, [activeProjectId, hasPendingClarification, liveVoiceContext, projects]);

  // hasBrowserNodes/hasOpenProjects mirror the exact gates `realtimeTools` uses below (see
  // `realtimeToolAvailable`), so the spoken persona never promises a tool that isn't advertised.
  const hasOpenProjects = !!(projects && projects.length > 0);
  const instructions = useMemo(
    () =>
      buildS2sCanvasInstructions({
        projectName: projectName ?? cwd.split("/").filter(Boolean).pop() ?? null,
        agentNames: liveVoiceContext.agentNames,
        nodeSummaries: liveVoiceContext.nodeSummaries,
        hasBrowserNodes: liveVoiceContext.hasBrowserNodes,
        hasOpenProjects,
        verbosity: responseVerbosity,
        personaBody,
      }),
    [cwd, hasOpenProjects, liveVoiceContext.agentNames, liveVoiceContext.hasBrowserNodes, liveVoiceContext.nodeSummaries, personaBody, projectName, responseVerbosity],
  );

  const recordFinalUserTranscript = useCallback((text: string, itemId?: string) => {
    bufferRef.current = appendFinalUserTranscript(bufferRef.current, text, {
      itemId,
      now: Date.now(),
    });
    const resolved = authoritativeUserTranscript(bufferRef.current);
    transcriptWaitQueueRef.current.resolveFinal(resolved);
  }, []);

  const recordUserTranscriptProgress = useCallback(
    (text: string, isFinal: boolean, meta?: { itemId?: string; cumulative?: boolean }) => {
      if (isFinal) return;
      transcriptWaitQueueRef.current.noteProgress();
      // xAI documents `…input_audio_transcription.updated` as the CUMULATIVE input transcript for
      // `grok-transcribe`: it is authoritative text, not a throwaway partial, and discarding it left
      // every Grok dispatch paraphrasing from the model's `intent`. Gate on the EVENT flag, never on
      // the provider kind — an unrecognised kind resolves to "cumulative-safe" (correct for the merge,
      // wrong for this decision), and appending OpenAI's incremental `.delta` verbatim is precisely
      // how the quadratic duplication returns.
      if (!meta?.cumulative) return;
      bufferRef.current = appendFinalUserTranscript(bufferRef.current, text, {
        itemId: meta.itemId,
        now: Date.now(),
      });
    },
    [],
  );

  // An uninterrupted agent reply means the turn is over — the next segment starts a new one. A
  // barged-in reply never reaches its final transcript, so this intentionally never fires for those,
  // which is what lets split VAD segments keep accumulating across a barge-in.
  const recordAgentFinalTranscript = useCallback(() => {
    bufferRef.current = markAgentReplied(bufferRef.current);
  }, []);

  /** Resolves with the next authoritative transcript, or null at the adaptive wait deadline. */
  const waitForFinalUserTranscript = useCallback(
    (): Promise<string | null> => transcriptWaitQueueRef.current.wait(),
    [],
  );

  useEffect(() => () => transcriptWaitQueueRef.current.reset(), []);

  const handleLiveVoiceTool = useCallback(
    async (_action: unknown, call: { callId: string; name: string; args: Record<string, unknown> }) => {
      let memoryCall = applyS2sVoiceDialogueMemory(call, dialogueRef.current);
      let transcript = authoritativeUserTranscript(bufferRef.current);
      if (memoryCall.name === "dispatch") {
        const target = typeof memoryCall.args.target === "string" ? memoryCall.args.target : "the selected agent";
        const intent = typeof memoryCall.args.intent === "string" ? memoryCall.args.intent : undefined;
        const keyConstraints = Array.isArray(memoryCall.args.key_constraints)
          ? memoryCall.args.key_constraints.filter(
              (value): value is string => typeof value === "string" && value.trim().length > 0,
            )
          : undefined;
        const candidateTask = typeof memoryCall.args.task === "string" ? memoryCall.args.task : intent ?? "";
        const socialMessage = resolveSocialAgentMessage(candidateTask, target);
        if (!socialMessage) {
          if (!transcript) {
            // The dispatch call often arrives before the async input transcription completes. Grace-wait
            // briefly for the segment instead of immediately degrading to paraphrase mode.
            transcript = await waitForFinalUserTranscript();
          }
          // The vocabulary is the FULL canvas vocabulary, not just agent names: a dispatch is exactly
          // where node, note, and task names get spoken, and they are the tokens STT is most likely to
          // mangle. Same builder the dictation path and the STT decoder hint use (ADR-0034), so all
          // three bias toward one list. Hoisted above the branch because every delivery shape needs the
          // roster — de-framing is applied to all of them.
          const vocabulary = buildCanvasVocabulary({
            roster: liveVoiceContext.roster,
            nodeNames: liveVoiceContext.nodeRefs.map((node) => node.name),
          });
          const roster = [target, ...vocabulary];
          let compiledTask: string | undefined;
          if (transcript) {
            // The integrity gate scores the RAW transcript first and owns the mode decision. Composing
            // before this point would let the rewrite quietly de-duplicate accumulator corruption and
            // hide it from `transcript-integrity.ts`.
            const compiled = compileAgentDelegation({
              target,
              transcript,
              language: "auto",
              intent,
              keyConstraints,
            });
            if (compiled.mode === "unusable") {
              // The transcript scored as corrupted AND there is no independent objective to fall back
              // on, so nothing trustworthy is left to delegate. Withhold the dispatch and ask instead
              // of sending a packet whose own scope is garbage.
              bufferRef.current = consumeUserTranscript(bufferRef.current);
              const error = "I didn't catch that clearly enough to delegate. Please say the request again.";
              setTrace({ text: error, tone: "error" });
              return { ok: false, error } satisfies S2sCanvasToolResult;
            }
            compiledTask = compiled.workerMessage;
            if (compiled.mode !== "direct") {
              // Structured: the compose REWRITE must not run here — the text is either not the user's
              // own words (a paraphrase) or is known to be incomplete (a cut-off tail), and polishing
              // either one would only make an unreliable capture read as if it were reliable.
              //
              // De-framing is a different thing entirely: deterministic, model-free, and just as
              // necessary. A cut-off capture still arrives as "so can you prompt Marshall that cek
              // auth.ts dan", and the agent reading it must not find itself described in third person.
              // Safe to apply to the whole message because the frame can only ever be leading, and any
              // trailing capture note is preserved by the strip.
              compiledTask = stripLeadingAddressingFrame(compiledTask, roster);
            } else {
              // Normal path: deliver the user's own words as clean prose (CNVS parity). De-framing is
              // local and deterministic; the model only polishes delivery on top, on a deadline, and a
              // fidelity guard vets the result — so an outage, a stall, or a bad rewrite all cost
              // polish and never meaning. Short filler-free commands skip the model entirely.
              if (callModel && shouldComposeVoicePrompt(transcript, roster)) {
                const workspace = hasVagueReference(transcript)
                  ? await gatherDispatchWorkspaceContext({ rootDir: cwd, nodes })
                  : undefined;
                const composition = await composeVoiceDispatchPromptDetailed(transcript, callModel, {
                  target,
                  projectName,
                  workspace,
                  vocabulary,
                });
                compiledTask = composition.text;
                // A rewrite that silently reverted to the raw transcript is invisible in the delivered
                // text alone — log why, next to the `[nl-model]` latency lines already on this path.
                if (isVoiceToolTraceEnabled() && composition.outcome !== "composed") {
                  console.info(
                    `[voice-compose] ${composition.outcome}${composition.failure ? `:${composition.failure}` : ""}` +
                      `${composition.modelMs !== undefined ? ` ${composition.modelMs}ms` : ""}` +
                      `${composition.verdict?.dropped.length ? ` dropped=${composition.verdict.dropped.join(", ")}` : ""}`,
                  );
                }
              } else {
                compiledTask = stripLeadingAddressingFrame(transcript, roster);
              }
            }
          } else if (intent) {
            // STT race: the authoritative transcript never arrived even after the grace-wait. Paraphrase
            // from the model's intent instead of blocking dispatch — no grounding round-trip since there
            // is no transcript to ground.
            //
            // De-framed for the same reason as the structured path above: `intent` is written by the
            // realtime model, which routinely phrases it the way the user spoke it ("suruh Nova jelaskan
            // project"), and that reads as third person to the agent receiving it.
            compiledTask = stripLeadingAddressingFrame(
              compileAgentDelegation({
                target,
                transcript: "",
                language: "auto",
                intent,
                keyConstraints,
                transcriptPending: true,
              }).workerMessage,
              roster,
            );
          }
          if (compiledTask !== undefined) {
            const restArgs = { ...memoryCall.args };
            delete restArgs.intent;
            delete restArgs.key_constraints;
            memoryCall = { ...memoryCall, args: { ...restArgs, task: compiledTask } };
          }
        }
      }

      // Awareness / memory tools answer a question or persist a fact — they don't flow through the
      // synchronous NlEffect executor or the target-clarification path. Run them async and record the
      // same trace + dialogue turn so diagnostics stay uniform.
      if (isS2sInfoTool(memoryCall.name)) {
        // The utterance led to an action — it must not leak into the next turn's dispatch packet.
        bufferRef.current = consumeUserTranscript(bufferRef.current);
        return executeS2sInfoToolCall(memoryCall, {
          roster: liveVoiceContext.roster,
          projectId: activeProjectId ?? null,
          memoryWrite: codecanvasMemoryWrite,
          memorySearch: codecanvasMemorySearch,
          readTranscript: getPersistentPtyTranscript,
        }).then((result) => {
          dialogueRef.current = recordS2sVoiceDialogueTurn(dialogueRef.current, result);
          if (isVoiceToolTraceEnabled()) {
            const traceEntry = buildVoiceToolTraceEntry(memoryCall, result, contextVersion);
            setVoiceToolTrace(traceEntry);
            recordS2sVoiceDiagnostic(traceEntry, contextVersion);
          }
          setTrace(result.ok ? { text: result.summary, tone: "ok" } : { text: result.error, tone: "error" });
          return result;
        });
      }

      const clarification = resolveS2sClarificationCall(memoryCall, clarificationRef.current);
      if (clarification.kind === "result") {
        bufferRef.current = consumeUserTranscript(bufferRef.current);
        clarificationRef.current = clarification.state;
        setHasPendingClarification(!!clarification.state.pending);
        if (isVoiceToolTraceEnabled()) {
          const traceEntry = buildVoiceToolTraceEntry(memoryCall, clarification.result, contextVersion);
          setVoiceToolTrace(traceEntry);
          recordS2sVoiceDiagnostic(traceEntry, contextVersion);
        }
        if (clarification.result.ok) {
          setTrace({ text: clarification.result.summary, tone: "ok" });
        } else {
          setTrace({ text: clarification.result.error, tone: "error" });
        }
        return clarification.result;
      }

      const groundedCall = clarification.call;
      clarificationRef.current = clarification.state;
      setHasPendingClarification(!!clarification.state.pending);
      // The utterance led to an action (dispatch or a canvas tool) — it must not leak into the next
      // turn's dispatch packet.
      bufferRef.current = consumeUserTranscript(bufferRef.current);
      const deliveryCompletions: Array<Promise<AgentMessageDeliveryReceipt[]>> = [];
      let result: S2sCanvasToolResult = executeS2sCanvasToolCall(
        groundedCall,
        {
          roster: liveVoiceContext.roster,
          nodeRefs: liveVoiceContext.nodeRefs,
          selectedNodeIds: nodes.filter((node) => node.selected).map((node) => node.id),
          namePool: currentNamePool(),
          projects,
          activeProjectId,
          previousProjectId,
        },
        {
          runCommand,
          dispatch: (agentId, message) => {
            const send = sendAgentMessageTracked(
              agentId,
              message,
              liveVoiceContext.roster,
              createAgentMessagingDeps(),
            );
            deliveryCompletions.push(send.completion);
            createCanvasCommandDeliveryEvents({
              source: "nl-command",
              targetNodeId: agentId,
              text: message,
              result: send,
            }).forEach((event) => onCommandDelivery?.(event));
            return send;
          },
          runApp,
        },
      );

      if (result.ok && deliveryCompletions.length > 0) {
        const receipts = (await Promise.all(deliveryCompletions)).flat();
        const failure = receipts.find((receipt) => receipt.state === "failed");
        if (failure) {
          result = {
            ok: false,
            error: failure.error ?? "Agent prompt delivery failed.",
            speak: "I couldn’t deliver that prompt to the agent.",
          };
        } else if (receipts.some((receipt) => receipt.state === "queued")) {
          result = {
            ...result,
            queued: true,
            delivery: "queued",
            speak: "The prompt is queued until the agent is ready.",
          };
        } else if (receipts.some((receipt) => receipt.state === "written")) {
          result = { ...result, delivery: "written" };
        }
      }

      clarificationRef.current = recordS2sPendingClarification(clarificationRef.current, groundedCall, result);
      setHasPendingClarification(!!clarificationRef.current.pending);
      dialogueRef.current = recordS2sVoiceDialogueTurn(dialogueRef.current, result);
      if (isVoiceToolTraceEnabled()) {
        const traceEntry = buildVoiceToolTraceEntry(groundedCall, result, contextVersion);
        setVoiceToolTrace(traceEntry);
        recordS2sVoiceDiagnostic(traceEntry, contextVersion);
      }
      if (result.ok) {
        setTrace({ text: result.summary, tone: "ok" });
      } else {
        setTrace({ text: result.error, tone: "error" });
      }
      return result;
    },
    [activeProjectId, callModel, contextVersion, cwd, liveVoiceContext, nodes, onCommandDelivery, previousProjectId, projectName, projects, runApp, runCommand, setTrace, waitForFinalUserTranscript],
  );

  const { strip, recordTranscript, recordTool, noteTurn, reset: resetStrip } = useLiveVoiceStripRecorder();
  // Every tool call, whichever path it took, is one line in the strip and one action in the summary.
  const runLiveVoiceTool = useCallback(
    (action: unknown, call: { callId: string; name: string; args: Record<string, unknown> }) =>
      recordTool(call, () => handleLiveVoiceTool(action, call)),
    [handleLiveVoiceTool, recordTool],
  );

  const liveTools = useMemo<VoiceLiveTools>(
    () => ({ instructions, tools: realtimeTools, execute: (call) => runLiveVoiceTool(undefined, call) }),
    [runLiveVoiceTool, instructions, realtimeTools],
  );

  const session = useCommandBarLiveVoice({
    instructions: liveTools.instructions,
    realtimeTools,
    onTranscript: recordTranscript,
    onUserTranscriptProgress: recordUserTranscriptProgress,
    onFinalUserTranscript: recordFinalUserTranscript,
    onAgentFinalTranscript: recordAgentFinalTranscript,
    onConciergeAction: runLiveVoiceTool,
    hasPendingClarification,
    autoEndPolicy: S2S_LIVE_VOICE_END_POLICY,
    onAutoEnd: (_reason, message) => setTrace({ text: message, tone: "ok" }),
  });
  useEffect(() => noteTurn(session.turn), [noteTurn, session.turn]);
  // A new session starts with an empty strip; the last one's stays readable until then.
  const live: CommandBarLiveVoice = {
    ...session,
    start: () => {
      resetStrip();
      return session.start();
    },
  };
  // Barge-in turn boundary. `markAgentReplied` only fires for a reply that COMPLETES, but eager VAD
  // makes barge-in the normal case, so an interrupted reply used to leave the previous utterance fresh
  // in the buffer — which is how "Oke, thank you" from an earlier turn ended up inside a work packet.
  // Agent audio starting is the reliable signal that the floor changed hands.
  useEffect(() => {
    if (!live.agentSpeaking) return;
    bufferRef.current = markAgentAudioStarted(bufferRef.current);
  }, [live.agentSpeaking]);

  useEffect(() => {
    if (!hasPendingClarification) return;
    const timeout = window.setTimeout(() => {
      clarificationRef.current = {};
      setHasPendingClarification(false);
    }, S2S_CLARIFICATION_TTL_MS);
    return () => window.clearTimeout(timeout);
  }, [hasPendingClarification]);

  const copyVoiceDiagnostics = useCallback(async () => {
    const result = await copyS2sVoiceDiagnostics();
    setVoiceDiagnosticsCopyState(result === "copied" ? "copied" : result === "empty" ? "empty" : "failed");
    window.setTimeout(() => setVoiceDiagnosticsCopyState("idle"), 1600);
  }, []);

  return { live, strip, liveTools, voiceToolTrace, voiceDiagnosticsCopyState, copyVoiceDiagnostics };
}
