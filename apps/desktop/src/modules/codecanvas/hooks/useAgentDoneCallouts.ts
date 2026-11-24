"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getPtySessionMetrics, type PtyOutputMetrics } from "@/lib/tauri-api";
import { useTtsProviderRegistry } from "@/lib/hooks/useTtsProviderRegistry";
import { useSttProviderRegistry } from "@/lib/hooks/useSttProviderRegistry";
import { useCellIdleWatcher } from "@/modules/codespace/hooks/useCellIdleWatcher";
import { agentStatusRegistry, type AgentStatusSnapshot } from "../services/agent-status-registry";
import { agentIdentityRegistry, type AgentIdentityRegistry } from "../services/agent-identity-registry";
import { paneTurnRegistry, type PaneTurnRegistry } from "../services/pane-turn-registry";
import { agentCalloutsEnabled, projectIdFromScopedPaneId, resolveFinishCallout } from "../services/voice/agent-done-callout";
import { agentDoneAlertKind } from "@/modules/voice-core/agent-done-alert";
import { CALLOUT_COOLDOWN_MS, createCalloutThrottle, type CalloutThrottle } from "../services/voice/callout-throttle";
import {
  bundledPersonaSource,
  loadPersona,
  personaNameForTone,
} from "../services/voice/persona/canvas-persona";
import type { AgentNodeStatus } from "../types/canvas";
import { subscribeAgentStopped as defaultSubscribeAgentStopped, type AgentStoppedSubscriber } from "../services/agent-stopped-event";

/** A resolved turn-end, reported to non-voice consumers (e.g. the completion toast). Fired once per
 *  turn for any KNOWN agent, independent of the voice toggles/policy. */
export interface AgentFinishInfo {
  /** The finishing pane id (node id or scoped LOTUS_PANE_ID). */
  paneId: string;
  /** ReactFlow node id of the agent. */
  agentId: string;
  /** Display name, if known. */
  agentName?: string;
  /** The agent's own project id (roster/identity/scoped-paneId), if known. */
  agentProjectId?: string;
  /** Whether the finishing node was on-screen at completion. */
  visible: boolean;
}

export interface AgentDoneCalloutDeps {
  /** Speak the callout — NOT gated by "Speak replies" (see {@link useVoiceFeedback}.announce).
   *  `language` lets the TTS engine pick a voice matching the callout's language. */
  announce: (text: string, opts?: { language?: string; priority?: "callout"; name?: string }) => void;
  /** The "sound" alert (Lotus #184): one batched chime. Absent → a sound-mode finish stays silent. */
  chime?: () => void;
  /** Whether a spoken line can play; voice falls back to the chime when it cannot. Absent = yes. */
  canSpeak?: () => boolean;
  /** Whether a node is currently within the viewport (background = false, visible = true). */
  isVisible: (nodeId: string) => boolean;
  /** The canvas project currently on screen — different/unknown context makes a finish name its repo. */
  activeProjectId?: string | null;
  /** projectId → human repo label (alias / basename); consulted when repo attribution is needed. */
  resolveProjectLabel?: (projectId: string) => string | null | undefined;
  /** Injectable for tests; defaults to the process-wide durable identity registry (survives unmount). */
  identityRegistry?: AgentIdentityRegistry;
  /** Injectable for tests; defaults to the PTY metrics IPC. */
  getMetrics?: (sessionId: string) => Promise<PtyOutputMetrics | null>;
  /** Injectable for tests; defaults to the `mcp://agent-stopped` Tauri event. */
  subscribeAgentStopped?: AgentStoppedSubscriber;
  /** Injectable for tests; defaults to the process-wide pane turn registry. */
  turnRegistry?: PaneTurnRegistry;
  /** Injectable for tests; defaults to the per-agent cooldown throttle (ultra-minimal frequency). */
  throttle?: CalloutThrottle;
  /** Injectable clock for the cooldown; defaults to `Date.now`. */
  now?: () => number;
  /** Optional non-voice consumer of turn-ends (the completion toast). Fired once per turn for any
   *  known agent, BEFORE and independent of the voice policy — so a toast shows even with callouts
   *  muted. Its presence also keeps the completion pipeline watching when voice is off. */
  /**
   * Live narration is on, so it already speaks a richer turn-end line (a persona summary of what
   * happened, not "X is done."). Both channels listen to the SAME stop hook and both speak through
   * `announce`, which is latest-wins — leaving both on produced two utterances per turn that cut
   * each other off. The finish is still reported to `onFinish`; only the spoken line is dropped.
   */
  narrationCoversTurnEnd?: boolean;
  onFinish?: (info: AgentFinishInfo) => void;
}

/**
 * Agent-done voice callouts (ADR-0031). Two signals, one policy ({@link resolveFinishCallout}):
 *
 *  1. **Primary — the CLI stop hook** (`mcp://agent-stopped`). Authoritative and per-turn: it fires
 *     every time the agent finishes a response, so a live agent is announced on every turn, instantly,
 *     without the ~10s latency or TUI-repaint fragility of the byte-idle heuristic.
 *  2. **Fallback — PTY busy→idle** ({@link useCellIdleWatcher}), the universal BACKSTOP: the only
 *     signal for hook-less runners (cursor/custom), and the safety net for hook-capable ones whose
 *     hook is dead (uninstalled/wiped). Panes whose hook has ever fired are skipped, and the
 *     per-turn claim ({@link PaneTurnRegistry.claimAnnouncement}) admits exactly one signal per
 *     turn, so a Claude/Codex agent is never announced twice.
 *     The fallback is additionally TURN-GATED ({@link PaneTurnRegistry}):
 *     a byte-settle only announces when a real submit opened a turn on the pane — repaints from
 *     resize/reattach/focus and keystroke echo never did, which is what used to produce callouts
 *     with no activity.
 *
 * Watches nothing when both callout toggles are off. The signal is *turn-done*, never process exit.
 */
export function useAgentDoneCallouts({
  announce,
  chime,
  canSpeak,
  isVisible,
  activeProjectId,
  resolveProjectLabel,
  identityRegistry = agentIdentityRegistry,
  getMetrics = getPtySessionMetrics,
  subscribeAgentStopped = defaultSubscribeAgentStopped,
  turnRegistry = paneTurnRegistry,
  throttle,
  now = Date.now,
  narrationCoversTurnEnd = false,
  onFinish,
}: AgentDoneCalloutDeps): void {
  const { registry } = useTtsProviderRegistry();
  const output = registry?.output;
  // Callout language follows the configured voice-INPUT language (see buildFinishCallout) —
  // the closest signal we have for what language the user actually speaks.
  const { registry: sttRegistry } = useSttProviderRegistry();
  const speechLanguage = sttRegistry?.providers.find((p) => p.id === sttRegistry.activeProvider)?.language;
  const [roster, setRoster] = useState<AgentStatusSnapshot[]>(() => agentStatusRegistry.list());
  useEffect(() => agentStatusRegistry.subscribe(setRoster), []);
  // Monotonic per-hook counter → rotates the callout phrasing so consecutive finishes don't repeat.
  const calloutCounterRef = useRef(0);
  // Panes that have EVER produced a stop-hook signal are "hook-covered": the idle fallback stays out
  // of their way (the hook is exact and per-turn; idle would double-announce or misfire on repaints).
  const hookCoveredRef = useRef<Set<string>>(new Set());
  const [hookCoveredIds, setHookCoveredIds] = useState<Set<string>>(() => new Set());
  // Per-agent cooldown cap (ultra-minimal): at most one spoken finish per agent per window, unless a
  // fresh user-submitted turn opened on the pane. Created once; an injected throttle wins (tests).
  const throttleRef = useRef<CalloutThrottle | null>(null);
  if (throttleRef.current === null) throttleRef.current = throttle ?? createCalloutThrottle();
  const nowRef = useRef(now);

  // Latest values, so the once-subscribed hook handler reads them without re-subscribing.
  const narrationCoversTurnEndRef = useRef(narrationCoversTurnEnd);
  const announceRef = useRef(announce);
  const chimeRef = useRef(chime);
  const canSpeakRef = useRef(canSpeak);
  const isVisibleRef = useRef(isVisible);
  const outputRef = useRef(output);
  const rosterRef = useRef(roster);
  const speechLanguageRef = useRef(speechLanguage);
  const activeProjectIdRef = useRef(activeProjectId);
  const resolveProjectLabelRef = useRef(resolveProjectLabel);
  const onFinishRef = useRef(onFinish);
  useLayoutEffect(() => {
    narrationCoversTurnEndRef.current = narrationCoversTurnEnd;
    announceRef.current = announce;
    chimeRef.current = chime;
    canSpeakRef.current = canSpeak;
    isVisibleRef.current = isVisible;
    outputRef.current = output;
    rosterRef.current = roster;
    speechLanguageRef.current = speechLanguage;
    activeProjectIdRef.current = activeProjectId;
    resolveProjectLabelRef.current = resolveProjectLabel;
    onFinishRef.current = onFinish;
    nowRef.current = now;
  }, [announce, chime, canSpeak, isVisible, output, roster, speechLanguage, activeProjectId, resolveProjectLabel, onFinish, now, narrationCoversTurnEnd]);

  // One resolver for both signals — reads refs so it is stable across renders. `freshTurn` marks a
  // finish that a user submit opened a turn for; it bypasses the cooldown cap so new user-initiated
  // work is always acknowledged, while unprompted churn inside the window stays silent.
  const fireCallout = useCallback((paneId: string, freshTurn: boolean, sessionId?: string | null) => {
    // Identity fallback: a cross-project agent's node has unmounted (its project was switched away
    // from) so it is gone from the live roster — the durable identity keeps its finish announceable
    // and carries the projectId needed to name its repo. The incoming paneId may be a project-scoped
    // hookPaneId. If only the fallback identity matches, the node is unmounted/switched away, so it
    // must be treated as background even if the active project has a colliding ReactFlow node id.
    const rosterMatch = rosterRef.current.find((r) => r.id === paneId || r.hookPaneId === paneId || (!!sessionId && r.sessionId === sessionId)) ?? null;
    const sessionIdentity = sessionId ? identityRegistry.get(`session:${sessionId}`) : undefined;
    const sessionIdentityWins = !!sessionIdentity && !!sessionId && rosterMatch?.sessionId !== sessionId;
    const identity = sessionIdentity ?? identityRegistry.get(paneId);
    // The known agent behind this finish — the live roster match, unless a session identity for an
    // unmounted node wins, or only the durable identity is left. Unknown pane → neither toast nor voice.
    const effectiveAgent =
      (sessionIdentityWins ? null : rosterMatch) ??
      (identity ? { id: identity.nodeId ?? paneId, name: identity.name, projectId: identity.projectId, hookPaneId: paneId } : null);
    if (!effectiveAgent) return;
    // Per-turn claim: whichever signal (stop hook or byte settle) arrives FIRST wins the turn's
    // single announcement — toast and voice together. A second signal about the SAME open turn is
    // denied here, regardless of the frequency throttle (cooldown=0 / freshTurn bypass that, never
    // this). A no-turn finish (headless completed transition) defers to its own one-shot guard.
    if (!turnRegistry.claimAnnouncement(paneId)) return;
    const visible = rosterMatch && !sessionIdentityWins ? isVisibleRef.current(rosterMatch.id) : false;

    // Toast side-effect FIRST — once per turn (the claim above dedups it), for ANY known agent, before
    // and independent of the voice policy so a toast shows even with callouts muted.
    const agentProjectId =
      effectiveAgent.projectId ??
      projectIdFromScopedPaneId(effectiveAgent.hookPaneId) ??
      projectIdFromScopedPaneId(paneId);
    onFinishRef.current?.({ paneId, agentId: effectiveAgent.id, agentName: effectiveAgent.name, agentProjectId, visible });

    // Voice path — gated by TTS settings + the visible/background policy.
    const out = outputRef.current;
    if (!out) return;
    // Narration speaks a richer turn-end line from the same stop hook. Two utterances through a
    // latest-wins speaker abort each other, so the terser one stands down.
    if (narrationCoversTurnEndRef.current) return;
    const callout = resolveFinishCallout(paneId, {
      roster: sessionIdentityWins ? [] : rosterRef.current,
      fallbackIdentity: identity ? { id: identity.nodeId ?? paneId, hookPaneId: paneId, name: identity.name, projectId: identity.projectId } : null,
      visible,
      settings: out,
      language: speechLanguageRef.current,
      variant: calloutCounterRef.current,
      activeProjectId: activeProjectIdRef.current,
      resolveProjectLabel: resolveProjectLabelRef.current,
      // The Speak-style setting picks the register this channel speaks in. Resolved per callout
      // rather than cached: it is four small strings parsed at most once every few seconds, and a
      // cache would have to be invalidated when the user changes the setting.
      personaPools: loadPersona(personaNameForTone(out.tone), [bundledPersonaSource()]).callouts,
    });
    if (!callout) return;
    // Ultra-minimal cap: collapse a burst of finishes for the same agent into one spoken line. The
    // window length is the user's Voice-tab setting (0 = no cap → announce every turn).
    const cooldownMs = out.agentDoneCooldownMs ?? CALLOUT_COOLDOWN_MS;
    if (!throttleRef.current!.tryEmit(paneId, nowRef.current(), freshTurn, cooldownMs)) return;
    const kind = agentDoneAlertKind(out, canSpeakRef.current?.() ?? true);
    if (kind === "sound") {
      chimeRef.current?.();
      return;
    }
    calloutCounterRef.current += 1;
    announceRef.current(callout, { language: speechLanguageRef.current, priority: "callout", name: effectiveAgent.name });
  }, [turnRegistry, identityRegistry]);

  // Watch ALL completion signals (stop hook, completed transition, byte-idle fallback) when voice
  // callouts are on OR a non-voice consumer (toast) is wired — hook-less runners (cursor/custom)
  // have no event-driven finish signal, so the toast channel must keep the idle poll alive even
  // with voice fully muted. Voice output itself stays gated by the TTS settings/policy in fireCallout.
  const voiceEnabled = agentCalloutsEnabled(output);
  const watch = voiceEnabled || !!onFinish;

  // Primary signal: subscribe once while watching. A stop hook is an authoritative turn end, so it
  // also closes the pane's turn window — a later byte-settle from the same turn can't re-announce.
  useEffect(() => {
    if (!watch) return;
    return subscribeAgentStopped((paneId, sessionId) => {
      hookCoveredRef.current.add(paneId);
      setHookCoveredIds((prev) => (prev.has(paneId) ? prev : new Set(prev).add(paneId)));
      // A turn open at hook time means a user submit kicked this off → a fresh task worth announcing
      // even inside the cooldown. `fireCallout` claims the turn (one callout per turn); the window is
      // left OPEN so a later idle settle for the SAME turn is denied by the claim, not re-announced.
      const freshTurn = turnRegistry.isTurnOpen(paneId);
      fireCallout(paneId, freshTurn, sessionId);
    });
  }, [watch, subscribeAgentStopped, fireCallout, turnRegistry]);

  // Headless / critic agents have no PTY session (no stop hook, no idle metrics), so the two paths
  // above can never reach them. Announce them on the authoritative registry transition INTO
  // "completed" (a finished run). Only edges are announced (not an already-completed agent on mount),
  // and only sessionId-less agents — live agents are covered by the hook/idle paths and their own
  // eventual "completed" is a process exit, not a turn boundary.
  const prevStatusRef = useRef<Map<string, AgentNodeStatus>>(new Map());
  useEffect(() => {
    if (!watch) return;
    const prev = prevStatusRef.current;
    for (const a of roster) {
      if (!a.sessionId) {
        const before = prev.get(a.id);
        // A completed headless run is an edge-triggered, one-shot terminal event (not per-turn
        // churn), so it always announces — freshTurn=true bypasses the cooldown.
        if (before && before !== "completed" && a.status === "completed") fireCallout(a.id, true);
      }
      prev.set(a.id, a.status);
    }
    for (const id of [...prev.keys()]) {
      if (!roster.some((r) => r.id === id)) {
        prev.delete(id);
        throttleRef.current!.clear(id); // agent gone → forget its cooldown so a re-add starts fresh
      }
    }
  }, [roster, watch, fireCallout]);

  // Fallback: PTY busy→idle — the universal BACKSTOP for every live pane. A hook-capable runner
  // (claude/codex) normally beats it with an instant stop hook, which marks the pane hook-covered
  // and drops it from the watch set; but a DEAD hook (e.g. the codex `notify` line wiped from
  // ~/.codex/config.toml by a config rewrite) must not silence a runner forever, so `hookCapable`
  // no longer excludes a pane a priori. Double-announce is impossible: fireCallout's per-turn claim
  // admits exactly one signal per open turn, and the fallback is still turn-gated (RCA P0 — bytes
  // alone are not work; resize/reattach repaints and keystroke echo never opened a turn).
  // Gated on `watch`, not voice alone: the toast channel needs this path for hook-less runners
  // (cursor/custom). Cost when voice is off: one metrics IPC per running uncovered pane per poll tick.
  const cells = watch
    ? roster
        .filter(
          (r) =>
            r.status === "running" &&
            !!r.sessionId &&
            // A pane that has EVER produced a stop hook is authoritative-covered — never byte-watch it
            // (a mislabeled custom-Claude runner fires the global hook despite hookCapable=false).
            !hookCoveredIds.has(r.hookPaneId ?? r.id),
        )
        .map((r) => ({ paneId: r.hookPaneId ?? r.id, sessionId: r.sessionId as string }))
    : [];

  useCellIdleWatcher({
    cells,
    enabled: watch,
    getMetrics,
    // Per-turn: a live session keeps the same PTY id across turns, so re-arm on each fresh burst of
    // output instead of firing only once per session (the old bug for non-hook runners).
    reArmOnActivity: true,
    onIdle: (paneId, sessionId) => {
      if (hookCoveredRef.current.has(paneId)) return;
      // Turn-gating (RCA P0): bytes alone are not work. A settle only counts as "the agent
      // finished" when a submit actually opened a turn on this pane — resize/reattach repaints,
      // keystroke echo and TUI ticks settle too, but they never opened a turn. Announcing closes
      // the window so one turn yields exactly one callout.
      if (!turnRegistry.isTurnOpen(paneId)) return;
      // The idle path only reaches here on an open (user-submitted) turn → a fresh task. `fireCallout`
      // claims the turn; if the stop-hook already announced this turn, the claim denies this one.
      fireCallout(paneId, true, sessionId);
    },
  });
}
