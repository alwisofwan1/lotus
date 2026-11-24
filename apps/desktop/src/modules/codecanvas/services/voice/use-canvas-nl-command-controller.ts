"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { nlComplete } from "@/lib/tauri-api";
import { createTauriAgentRunner } from "@/lib/tauri/canvas-agent";
import { useSttProviderRegistry } from "@/lib/hooks/useSttProviderRegistry";
import { currentNamePool } from "@/lib/agent-naming";
import { createLatencyTrace } from "../nl-latency";
import { agentStatusRegistry } from "../agent-status-registry";
import { createAgentMessagingDeps, sendAgentMessageTracked, type AgentMessageDeliveryReceipt } from "../canvas-agent-messaging";
import { waitForClassicVoiceStage } from "./classic-voice-stage-deadline";
import { createCanvasCommandDeliveryEvents, type CanvasCommandDeliveryEvent } from "../canvas-command-delivery";
import { collectDiagrams, formatCurrentDiagrams } from "../agent-draw/diagram-edit";
import { buildAgentProfile, gatherDispatchWorkspaceContext } from "../canvas-dispatch-context";
import { createNlModelCaller, type NlModelCaller, type NlTransportNotice } from "../nl-model-transport";
import { CANVAS_CREATE_NODE_KINDS, type CanvasCommand, type CanvasCommandResult } from "../commands/canvas-command";
import { bindBatchNodeIds, executeNlEffect, resolveClarifiedIntents, runNlCommand } from "../canvas-nl-runner";
import { EMPTY_DIALOGUE_STATE, recordNlTurn, type NlDialogueState } from "../canvas-nl-dialogue-state";
import { refineDispatchBatch } from "../refine-dispatch-prompt";
import { buildNodeIndex, summarizeResolutions, type AppCommand, type CanvasProjectRef, type NlClarification, type NlResolution } from "../canvas-nl-command";
import { detectSpeechLanguage } from "./speak-composer";
import { localizeConfirmation } from "./localize-confirmation";
import type { SpeechGate } from "@/modules/voice-core/speech-gate";

const NL_MODEL = "claude-haiku-4-5";
/** How long a dispatch waits for its write receipt before the bar says the status is unknown. */
const DISPATCH_RECEIPT_TIMEOUT_MS = 5_000;

/** True when the batch closes everything or more than one node. */
function isBulkClose(batch: readonly NlResolution[]): boolean {
  let closes = 0;
  for (const resolution of batch) {
    if (resolution.effect.kind !== "command") continue;
    if (resolution.effect.command.kind === "close-all-nodes") return true;
    if (resolution.effect.command.kind === "close-node") closes += 1;
  }
  return closes > 1;
}

type Trace = { text: string; tone: "ok" | "error" };

type ModelCall = (prompt: string, schema?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<string>;

/** Bind a turn's abort signal into every model call, so a cancelled or superseded turn stops them. */
function showCommandError(err: unknown, setTrace: (trace: { text: string; tone: "error" }) => void) {
  console.warn("[nl] command failed:", err);
  setTrace({ text: err instanceof Error && err.message ? err.message : "Command failed — try again.", tone: "error" });
}

function modelWithSignal(call: ModelCall, signal: AbortSignal | undefined) {
  return (prompt: string, schema?: Record<string, unknown>) => call(prompt, schema, signal ? { signal } : undefined);
}

export type NlProviderNotice = {
  kind: "auth" | "quota" | "config" | "cli-auth";
  title: string;
  detail: string;
};

function providerNoticeFor(kind: NlTransportNotice["kind"]): NlProviderNotice | null {
  switch (kind) {
    case "auth":
      return { kind, title: "NL provider needs attention", detail: "The API key was rejected. Review the model connection in Settings." };
    case "quota":
      return { kind, title: "NL credits exhausted", detail: "Top up this provider or choose another model in Settings." };
    case "config":
      return { kind, title: "NL model unavailable", detail: "Review the provider and model id in Settings." };
    case "cli-auth":
      return { kind, title: "Claude needs sign-in", detail: "AI interpretation is paused. Local canvas commands still work." };
    case "transient":
    case "cli-fallback":
      return null;
  }
}

export interface CanvasNlCommandControllerOptions {
  nodes: Node[];
  edges?: Edge[];
  cwd: string;
  callModel?: ModelCall;
  projects?: CanvasProjectRef[];
  activeProjectId?: string;
  previousProjectId?: string;
  runCommand: (command: CanvasCommand) => CanvasCommandResult | void;
  runApp: (command: AppCommand) => boolean;
  speechGate: SpeechGate;
  onCommandDelivery?: (event: CanvasCommandDeliveryEvent) => void;
  setTrace: (trace: Trace | null) => void;
  setText: (text: string) => void;
}

export type CanvasNlSubmitOptions = {
  input?: "typed" | "voice";
  /** The turn's signal: aborting it cancels the model calls and stops the result from applying. */
  signal?: AbortSignal;
};

export interface CanvasNlCommandController {
  busy: boolean;
  progress: string | null;
  pending: NlResolution[] | null;
  clarify: NlClarification | null;
  providerNotice: NlProviderNotice | null;
  getModelCaller: () => NlModelCaller;
  /** False when the command did not run: an error, a failed write, or a cancelled turn. */
  submitQuery: (rawQuery: string, options?: CanvasNlSubmitOptions) => Promise<boolean>;
  applyPending: () => void;
  cancelPending: () => void;
  cancelClarify: () => void;
  dismissProviderNotice: () => void;
  onClarifyPick: (chosenId: string) => Promise<void>;
}

export function useCanvasNlCommandController({
  nodes,
  edges,
  cwd,
  callModel,
  projects,
  activeProjectId,
  previousProjectId,
  runCommand,
  runApp,
  speechGate,
  onCommandDelivery,
  setTrace,
  setText,
}: CanvasNlCommandControllerOptions): CanvasNlCommandController {
  const dialogueStateRef = useRef<NlDialogueState>(EMPTY_DIALOGUE_STATE);
  const pendingQueryRef = useRef<string>("");
  const { registry: sttRegistry } = useSttProviderRegistry();
  const sttLanguage = sttRegistry?.providers.find((p) => p.id === sttRegistry.activeProvider)?.language;

  const [providerNotice, setProviderNotice] = useState<NlProviderNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, setPending] = useState<NlResolution[] | null>(null);
  const [clarify, setClarify] = useState<NlClarification | null>(null);
  const modelCallerRef = useRef<{ cwd: string; caller: NlModelCaller } | null>(null);
  // Clarify picks bypass the Push-to-Talk session, so they keep their own guard. A ref, not `busy`:
  // two clicks in the same tick both read the same render's `busy === false`.
  const clarifyInFlightRef = useRef(false);

  const getModelCaller = useCallback(() => {
    const current = modelCallerRef.current;
    if (current && current.cwd === cwd) return current.caller;
    current?.caller.dispose();
    const caller = createNlModelCaller({
      nlComplete,
      runner: createTauriAgentRunner(),
      cwd,
      cliModel: NL_MODEL,
      // BYOK is the sole path once a key is configured, so these notices no longer announce a
      // fallback — they name a configuration problem the user has to fix for the bar to work at all.
      // Transient/cli-fallback kinds are informational and deliberately get no banner.
      onNotice: (n) => {
        const notice = providerNoticeFor(n.kind);
        if (notice) setProviderNotice(notice);
      },
    });
    modelCallerRef.current = { cwd, caller };
    return caller;
  }, [cwd]);

  useEffect(
    () => () => {
      modelCallerRef.current?.caller.dispose();
      modelCallerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    dialogueStateRef.current = EMPTY_DIALOGUE_STATE;
  }, [cwd]);

  // Dispatches use the tracked delivery Live Voice uses: success is reported only once the agent's
  // write receipt lands, a failed write is an error, and a buffered agent reads as queued.
  const apply = useCallback(
    async (batch: NlResolution[], spokenQuery?: string, signal?: AbortSignal): Promise<boolean> => {
      const undelivered: string[] = [];
      const unresolved: string[] = [];
      const failed: string[] = [];
      let anyQueued = false;
      const realIds: (string | undefined)[] = [];
      const touchedIds: string[] = [];
      const receipts: Array<{ summary: string; completion: Promise<AgentMessageDeliveryReceipt[]> }> = [];
      batch.forEach((res, i) => {
        const bound = bindBatchNodeIds(res.effect, realIds);
        if (!bound) {
          unresolved.push(res.summary);
          return;
        }
        const outcome = executeNlEffect(bound, {
          runCommand,
          dispatch: (agentId, message) => {
            const send = sendAgentMessageTracked(agentId, message, agentStatusRegistry.list(), createAgentMessagingDeps());
            // A target with no session is reported as undelivered below, not as a failed write.
            if (send.delivered.length || send.queued.length) receipts.push({ summary: res.summary, completion: send.completion });
            return send;
          },
          runApp,
        });
        if (bound.kind === "command") {
          if (outcome.command?.error) failed.push(`${res.summary} — ${outcome.command.error}`);
          realIds[i] = outcome.command?.nodeId;
          const touched = outcome.command?.nodeId ?? ("nodeId" in bound.command && typeof bound.command.nodeId === "string" ? bound.command.nodeId : undefined);
          if (touched) touchedIds.push(touched);
        } else if (bound.kind === "app") {
          if (outcome.appDelivered === false) failed.push(`${res.summary} — not available here`);
        } else if (bound.kind === "dispatch" && outcome.send) {
          createCanvasCommandDeliveryEvents({
            source: "nl-command",
            targetNodeId: bound.agentId,
            text: bound.text,
            result: outcome.send,
          }).forEach((event) => onCommandDelivery?.(event));
          if (outcome.send.delivered.length === 0 && outcome.send.queued.length === 0) undelivered.push(res.summary);
        }
      });

      for (const { summary, completion } of receipts) {
        let settled: AgentMessageDeliveryReceipt[];
        try {
          settled = await waitForClassicVoiceStage(completion, {
            stage: "Agent delivery confirmation",
            timeoutMs: DISPATCH_RECEIPT_TIMEOUT_MS,
            signal,
          });
        } catch {
          if (signal?.aborted) return false;
          failed.push(`${summary} — delivery confirmation timed out, write status is unknown`);
          continue;
        }
        const failure = settled.find((receipt) => receipt.state === "failed");
        if (failure) failed.push(`Couldn't deliver: ${summary} — ${failure.error ?? "agent prompt delivery failed"}`);
        else if (settled.some((receipt) => receipt.state === "queued")) anyQueued = true;
      }
      if (signal?.aborted) return false;

      if (undelivered.length || unresolved.length || failed.length) {
        const parts = [
          undelivered.length ? `${undelivered.join(" · ")} — agent isn't running yet (launch it first)` : "",
          unresolved.length ? `Couldn't resolve: ${unresolved.join(" · ")}` : "",
          failed.length ? failed.join(" · ") : "",
        ].filter(Boolean);
        setTrace({ text: parts.join(" · "), tone: "error" });
        return false;
      }

      const { trace: summary, speak: spoken } = summarizeResolutions(batch);
      setTrace({ text: anyQueued ? `${summary} — queued until the agent is ready` : summary, tone: "ok" });
      dialogueStateRef.current = recordNlTurn(dialogueStateRef.current, {
        utterance: (spokenQuery ?? "").trim(),
        actions: batch.map((r) => r.summary),
        resolvedNodeIds: Array.from(new Set(touchedIds)),
        outcome: "ok",
      });
      if (spoken) {
        const language = detectSpeechLanguage(spokenQuery ?? "", sttLanguage);
        const localizedSpoken = localizeConfirmation(batch, language);
        // Latency-first voice UX: acknowledge the completed action with the deterministic
        // registry/localized phrase, not a model-composed one that trails the action by seconds.
        speechGate.open()(localizedSpoken, { language });
      }
      return true;
    },
    [onCommandDelivery, runApp, runCommand, setTrace, speechGate, sttLanguage],
  );

  const finishResolved = useCallback(
    async (resolutions: NlResolution[], query: string, options?: CanvasNlSubmitOptions): Promise<boolean> => {
      const optimistic = summarizeResolutions(resolutions).trace;
      if (optimistic) setProgress(`${optimistic}…`);
      const model = modelWithSignal(callModel ?? getModelCaller().call, options?.signal);
      const batch = await refineDispatchBatch(resolutions, {
        rawQuery: query,
        projectName: cwd.split("/").filter(Boolean).pop() ?? null,
        agentProfile: (id) => buildAgentProfile(id, nodes, agentStatusRegistry.list()),
        callModel: model,
        getWorkspace: () => gatherDispatchWorkspaceContext({ rootDir: cwd, nodes }),
      });
      if (options?.signal?.aborted) return false;
      // Typed: confirm destructive actions. Push-to-Talk: confirm only a bulk close, because a
      // truncated transcript ("close all agents except Atlas" → "close all agents") must not close
      // the wrong nodes. Temporary until dictation stops truncating (ADR-0053); one node closes at once.
      const needsConfirmation =
        options?.input === "voice" ? isBulkClose(batch) : batch.some((r) => r.destructive);
      if (needsConfirmation) {
        pendingQueryRef.current = query;
        setPending(batch);
        return true;
      }
      setText("");
      return apply(batch, query, options?.signal);
    },
    [apply, callModel, cwd, getModelCaller, nodes, setText],
  );

  const submitQuery = useCallback(
    async (rawQuery: string, options?: CanvasNlSubmitOptions): Promise<boolean> => {
      const query = rawQuery.trim();
      // No in-flight guard here: every caller runs inside a Push-to-Talk turn, and the session is the
      // one guard. A superseded call keeps running only until its abort check below.
      if (!query || options?.signal?.aborted) return false;
      speechGate.interrupt();
      setBusy(true);
      setTrace(null);
      setPending(null);
      setProviderNotice(null);
      const signal = options?.signal;
      const model = modelWithSignal(callModel ?? getModelCaller().call, signal);
      const latency = createLatencyTrace();
      try {
        const result = await runNlCommand(query, {
          callModel: model,
          roster: agentStatusRegistry.list(),
          nodeRefs: buildNodeIndex(nodes),
          selectedNodeIds: nodes.filter((node) => node.selected).map((node) => node.id),
          nodeKinds: CANVAS_CREATE_NODE_KINDS,
          namePool: currentNamePool(),
          projects,
          activeProjectId,
          previousProjectId,
          dialogueState: dialogueStateRef.current,
          currentDiagrams: formatCurrentDiagrams(collectDiagrams(nodes, edges ?? [])),
        });
        latency.mark("parse");
        if (signal?.aborted) return false;
        if ("error" in result) {
          if (result.clarify) {
            setClarify(result.clarify);
            return true;
          }
          setTrace({ text: result.error, tone: "error" });
          return false;
        }
        if ("answer" in result) {
          setTrace({ text: result.answer, tone: "ok" });
          speechGate.open()(result.answer, { language: detectSpeechLanguage(query, sttLanguage) });
          setText("");
          return true;
        }
        const ok = await finishResolved(result, query, options);
        latency.mark("apply");
        return ok;
      } catch (err) {
        // Shown, never unhandled. A superseded turn's failure is no longer the user's business.
        if (!signal?.aborted) showCommandError(err, setTrace);
        return false;
      } finally {
        console.info(latency.summary());
        clarifyInFlightRef.current = false;
        setBusy(false);
        setProgress(null);
      }
    },
    [activeProjectId, callModel, edges, finishResolved, getModelCaller, nodes, previousProjectId, projects, setText, setTrace, speechGate, sttLanguage],
  );

  const onClarifyPick = useCallback(
    async (chosenId: string) => {
      const pendingClarify = clarify;
      if (!pendingClarify) return;
      setClarify(null);
      const resolutions = resolveClarifiedIntents(
        pendingClarify.intents,
        {
          roster: agentStatusRegistry.list(),
          nodeRefs: buildNodeIndex(nodes),
          selectedNodeIds: nodes.filter((n) => n.selected).map((n) => n.id),
          namePool: currentNamePool(),
          projects,
          activeProjectId,
          previousProjectId,
          dialogueState: dialogueStateRef.current,
        },
        { chosenId, candidateIds: pendingClarify.candidates.map((c) => c.id) },
      );
      if ("error" in resolutions) {
        setTrace({ text: resolutions.error, tone: "error" });
        return;
      }
      if (clarifyInFlightRef.current) return;
      clarifyInFlightRef.current = true;
      setBusy(true);
      try {
        await finishResolved(resolutions, pendingClarify.ambiguousName);
      } catch (err) {
        showCommandError(err, setTrace);
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [activeProjectId, clarify, finishResolved, nodes, previousProjectId, projects, setTrace],
  );

  const applyPending = useCallback(() => {
    if (!pending) return;
    void apply(pending, pendingQueryRef.current);
    setPending(null);
    setText("");
  }, [apply, pending, setText]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setTrace({ text: "Cancelled", tone: "error" });
  }, [setTrace]);

  const cancelClarify = useCallback(() => setClarify(null), []);
  const dismissProviderNotice = useCallback(() => setProviderNotice(null), []);

  return { busy, progress, pending, clarify, providerNotice, getModelCaller, submitQuery, applyPending, cancelPending, cancelClarify, dismissProviderNotice, onClarifyPick };
}
