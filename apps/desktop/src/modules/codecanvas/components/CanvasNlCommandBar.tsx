"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { CanvasFrameSwitcher } from "./CanvasFrameSwitcher";
import { frameSwitcherSlotCount } from "../services/canvas-frame-switcher";
import { Sparkles, Loader2, Settings, Copy, TerminalSquare, X } from "lucide-react";
import type { CanvasAppNav } from "./CanvasControlCluster";
import { CanvasDockedNav } from "./CanvasDockedNav";
import { CanvasMachineStatus, type CanvasMachineStatusProps } from "./CanvasMachineStatus";
import { CANVAS_SHEET_LISTBOX_ID, CanvasCommandSheet, sheetRowId } from "./CanvasCommandSheet";
import { useCanvasCommandSheet } from "../hooks/useCanvasCommandSheet";
import type { CanvasSessionRecord } from "../services/session-record";
import { LiveVoiceComposerRow } from "./LiveVoiceComposerRow";
import { useElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { spectrumToConicGradient, computeLevel, stepOnsetPulse } from "@/modules/voice-core/spectrum-visual";
import { useVoiceAccuracySettings } from "../hooks/useVoiceAccuracySettings";
import { useVoiceInputSettings } from "../hooks/useVoiceInputSettings";
import { useManualDictationPolish } from "../services/voice/use-manual-dictation-polish";
import { composerTargetFor } from "../services/voice/composer-target";
import { buildCanvasVoiceContextFromNodes } from "../services/voice/canvas-voice-node-context";
import { resolveAddressedCanvasTerminalText } from "../services/terminal/canvas-terminal-delivery";
import {
  ComposerTargetLabel,
  VoiceSlot,
  VoiceTimer,
  VoiceWave,
  useListeningRow,
  useVoiceKeyLabel,
  LiveVoiceStrip,
  LiveVoiceSummary,
} from "@/modules/workspace-shell/components/composer-voice-parts";
import { useLiveVoiceSession } from "@/modules/voice-core/use-live-voice-session";
import { SPECTRUM_BAND_COUNT } from "@/modules/voice-core/spectrum-visual";
import { noteSelectionRegistry } from "../services/voice/note-selection-registry";
import { commandBarFocusRegistry } from "../services/command-bar-focus-registry";
import { createSpeechGate } from "@/modules/voice-core/speech-gate";
import { agentStatusRegistry } from "../services/agent-status-registry";
import type { CanvasCommand, CanvasCommandResult } from "../services/commands/canvas-command";
import { summarizeResolutions, type AppCommand, type CanvasProjectRef } from "../services/canvas-nl-command";
import { useCanvasLiveVoiceController } from "../services/voice/use-canvas-live-voice-controller";
import { useReportLiveVoiceActive } from "@/modules/voice-core/live-voice-status";
import {
  useCanvasTurnVoiceController,
  describeMicError as describeMicErrorImpl,
} from "../services/voice/use-canvas-turn-voice-controller";
import { useCanvasVoiceRoutes } from "../services/voice/use-canvas-voice-routes";
import { useCanvasNlCommandController } from "../services/voice/use-canvas-nl-command-controller";
import { isVoiceToolTraceEnabled } from "../services/voice/s2s-voice-tool-trace";
import { projectDisplayName, buildRecentProjects } from "../services/recent-projects";
import type { CanvasCommandDeliveryEvent } from "../services/canvas-command-delivery";
import type { Edge, Node } from "@xyflow/react";
import { useDockedOccluder } from "../hooks/useDockedOccluder";
import { useCanvasBehaviorSettings } from "../hooks/useCanvasBehaviorSettings";
import { buildNlHintPhrases } from "../services/nl-hint-phrases";
import { useNlHintRotator } from "../services/voice/use-nl-hint-rotator";

export const describeMicError = describeMicErrorImpl;

/** How long a result/feedback lingers in the input placeholder before the bar resets to its prompt. */
const TRACE_DISMISS_MS = 4_500;
/** Max NL input height before it scrolls internally — keeps a long dictation from growing the bar off-screen. */
const NL_INPUT_MAX_HEIGHT_PX = 160;
/** One switcher button's footprint in rem: its --cc-control (1.625rem) box plus the 0.125rem gap. */
const FRAME_SLOT_REM = 1.75;
/** The docked Lotus mark's footprint in rem: its divider (1px + 0.75rem margin) plus its --cc-control box. */
const BRAND_SLOT_REM = 2.5;

/** Above this measured input height the bar is multiline — controls bottom-pin instead of centering. */
const NL_INPUT_SINGLE_LINE_PX = 30;

interface Props {
  /** Executes a resolved canvas command through the command center. */
  runCommand: (command: CanvasCommand) => CanvasCommandResult | void;
  /** Live canvas nodes — the pool for resolving focus/close targets by name. */
  nodes: Node[];
  /** Live canvas edges — used to ground the planner on existing diagrams (edit-in-place). */
  edges?: Edge[];
  /** Working directory for the NL parse model call. */
  cwd: string;
  /**
   * Press a session row in ⌘K. Threaded from the page rather than decided here: making a node for a
   * session is a board effect, and every surface has to route through the one dispatcher
   * (`plans/codecanvas-session-refactor/issues/03`).
   */
  onDispatchSession?: (session: CanvasSessionRecord) => void | Promise<void>;
  /** Injectable model caller (tests); defaults to the canvas agent runner. */
  callModel?: (prompt: string, schema?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<string>;
  /** Speaks a confirmation through the active TTS provider (voice feedback). Optional / no-op in
   *  tests. `language` tells the engine which voice family the text needs (e.g. "id"). */
  speak?: (text: string, opts?: { language?: string }) => void;
  /** Stops in-flight TTS (VoiceFeedback.stop) — called on barge-in: when the user starts a mic
   *  capture or submits a command that supersedes the previous turn's confirmation. */
  stopSpeaking?: () => void;
  /** Emits a transient visual delivery cue after an NL dispatch reaches an agent. */
  onCommandDelivery?: (event: CanvasCommandDeliveryEvent) => void;
  /** The app-effect channel: open projects + navigation callbacks that switch_project / open_page /
   *  new_project / close_project resolve against. Independent of layout — the host has this
   *  available whether or not the top controls are docked into this bar, so those NL/voice intents
   *  work in the default top-bar layout too (voice's tool advertisement gates switch_project on
   *  `projects` being non-empty, fed by this same channel). */
  appNav?: CanvasAppNav;
  /** When present, the top-bar controls dock into this command bar (CNVS "In command bar" layout):
   *  the project switcher, Canvases and Settings render to the right of the input, and the pill widens.
   *  Absent = today's default (controls live in their own top pill). Also serves as the app-effect
   *  channel, taking precedence over `appNav` when both are given. */
  docked?: CanvasAppNav & { fallbackName?: string | null };
  /** Frame Switcher chips (LOT2-124). Rendered in the docked cluster, left of the Canvases button. */
  frameSwitcher?: ComponentProps<typeof CanvasFrameSwitcher>;
  /** The remote project's machine, beside the project name in the docked cluster (board 22). */
  machine?: CanvasMachineStatusProps | null;
  /** Docked only: where the zoom/memory/sessions controls portal into the bar (CanvasDockedNav). */
  cornerSlots?: ComponentProps<typeof CanvasDockedNav>["cornerSlots"];
}

/**
 * The natural-language command bar (Fase 1): type an intent ("create a terminal",
 * "focus Skye", "tell Rex to fix the bug") → the Bridge parses it → it runs through the
 * canonical command center / agent messaging. Safe actions apply immediately with a visible
 * trace; destructive ones (close) ask for confirmation first.
 */
export function CanvasNlCommandBar({ runCommand, nodes, edges, cwd, callModel, speak, stopSpeaking, onCommandDelivery, docked, appNav, onDispatchSession, frameSwitcher, machine, cornerSlots }: Props) {
  const voiceAccuracy = useVoiceAccuracySettings();
  // The app-effect channel, decoupled from the docked *layout*: `docked` still wins when present (it's
  // the richer shape with fallbackName), but a non-docked host can supply the same navigation via
  // `appNav` so switch_project/open_page/new_project/close_project resolve regardless of layout.
  const nav = docked ?? appNav;
  const [text, setText] = useState("");
  // Voice runs in Auto by default. The remappable Command/Dictate hotkeys are explicit one-capture
  // overrides owned entirely by the turn controller; no hidden mode survives into later submissions.
  const navProjects = nav?.projects;
  const navActiveProjectId = nav?.activeProjectId;
  // Open projects as NL-matchable refs (name = alias || folder basename), so "switch to project Beta"
  // and "close project X" resolve against the real project list. Only meaningful when the app-effect
  // channel is wired (the host provides projects + navigation callbacks); undefined otherwise so those
  // intents error cleanly.
  const projectRefs = useMemo<CanvasProjectRef[] | undefined>(
    () => navProjects?.map((p) => ({ id: p.id, name: projectDisplayName(p) })),
    [navProjects],
  );
  // The project "go back" resolves to — the most-recently-opened project other than the active one.
  const previousProjectId = useMemo<string | undefined>(
    () => (navProjects ? buildRecentProjects(navProjects, { excludeId: navActiveProjectId })[0]?.id : undefined),
    [navProjects, navActiveProjectId],
  );
  // Routes an app-level effect (switch project / open a page / new / close project) to the host's
  // navigation callbacks. No-op when the channel isn't wired — app intents can't resolve without projects.
  const runApp = useCallback(
    (command: AppCommand): boolean => {
      if (!nav) return false; // no app-effect channel → the effect is a no-op, report it as such
      switch (command.type) {
        case "switch-project":
          nav.onSelectProject(command.projectId);
          return true;
        case "open-page":
          if (command.page === "settings") nav.onOpenSettings();
          else nav.onOpenCanvases();
          return true;
        case "new-project":
          nav.onNewProject();
          return true;
        case "close-project":
          nav.onCloseProject(command.projectId);
          return true;
      }
    },
    [nav],
  );
  const [trace, setTrace] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [inputMultiline, setInputMultiline] = useState(false);
  // Focus drives the engaged geometry AND freezes the hint rotation — the line must stop moving the
  // moment the user engages with the field.
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // A resize re-wraps the text, so the auto-size below re-measures on a width change too.
  const [measureInput, { width: inputWidth }] = useElementSize<HTMLTextAreaElement>();
  const setInput = useCallback(
    (element: HTMLTextAreaElement | null) => {
      inputRef.current = element;
      measureInput(element);
    },
    [measureInput],
  );
  const barRef = useRef<HTMLDivElement>(null);
  // The hint slot the rotator writes into directly. Deliberately a ref, not state: the rotation is a
  // DOM write on a 4.5s timer and must never re-render a bar that repaints at 60fps during capture.
  const hintSlotRef = useRef<HTMLSpanElement>(null);
  // How the bar looks at rest — "slab" (a solid bar) or "veil" (a bottom strip that gathers into the
  // pill when engaged). Purely presentational: everything from hover onward is identical.
  const { commandBarRest } = useCanvasBehaviorSettings();
  // Browser nodes clip their native WebView around this bar so it never covers the command surface.
  useDockedOccluder(barRef);
  // Bridge for the "/" "type-to-focus" hotkey (plans/nl-type-to-focus): the dispatcher lives
  // in CanvasPage, several components away, so register a focus function the registry can call.
  // No refusal logic needed here — while live voice is active the textarea below isn't rendered at
  // all (inputRef.current is null) and while busy it's disabled, so `.focus()` on either target
  // already no-ops; the registry itself turns that no-op into an honest `false`.
  useEffect(() => commandBarFocusRegistry.register(() => inputRef.current?.focus()), []);
  // The listening-border FX layer. Live spectrum frames are written here as CSS custom properties
  // (never React state) so the border repaints at 60fps without re-rendering the whole bar. The
  // gradient is spatially anchored at the mic (spectrumToConicGradient's default anchorDeg) rather than
  // rotating — all perceived motion comes from the live band/level/onset values changing, so the effect
  // always reads as "reacting to your voice" instead of animating on its own.
  const fxRef = useRef<HTMLDivElement>(null);
  // Per-frame envelope state for the onset "kick" (D) — deliberately a ref, not state: this updates at
  // the sampler's frame rate and must never trigger a re-render.
  const onsetStateRef = useRef<{ time: number; level: number; pulse: number } | null>(null);
  // Throttle the (expensive) listening-border repaint to ~30fps. The sampler ticks at the display's
  // frame rate (up to 60/120Hz), but rebuilding the conic-gradient string + WebKit recomputing its
  // nested oklab color-mix stops every frame is the single heaviest sustained main-thread cost while
  // the mic is open — including the silent gap before push-to-talk is stopped. 30fps looks identical
  // for a shimmer and roughly halves that cost. (Perf fix — see voice hang analysis.)
  const lastFxWriteRef = useRef(0);
  const FX_MIN_INTERVAL_MS = 33;
  // The shared waveform reads `--voice-band-<n>` from the input row (composer-voice-parts › VoiceWave).
  const inputRowRef = useRef<HTMLDivElement>(null);
  const onSpectrum = useCallback((bands: number[]) => {
    // Square-rooted, as Code writes them: speech rarely fills a band, and a linear bar barely leaves
    // the floor at conversational volume.
    const row = inputRowRef.current;
    bands.forEach((value, band) => row?.style.setProperty(`--voice-band-${band}`, Math.sqrt(value).toFixed(3)));
    const el = fxRef.current;
    if (!el) return;
    const now = performance.now();
    // Throttle ONLY the expensive conic-gradient rebuild (the WebKit oklab color-mix recompute) to
    // ~30fps. Level + onset are cheap scalar writes and stay per-frame so the pulse envelope is smooth.
    if (now - lastFxWriteRef.current >= FX_MIN_INTERVAL_MS) {
      lastFxWriteRef.current = now;
      el.style.setProperty("--nl-spectrum", spectrumToConicGradient(bands));
    }
    const level = computeLevel(bands);
    el.style.setProperty("--nl-level", level.toFixed(3));

    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      el.style.setProperty("--nl-onset", "0");
      return;
    }
    const prev = onsetStateRef.current;
    const dt = prev ? now - prev.time : 0;
    const pulse = stepOnsetPulse(prev?.pulse ?? 0, level - (prev?.level ?? level), dt);
    onsetStateRef.current = { time: now, level, pulse };
    el.style.setProperty("--nl-onset", pulse.toFixed(3));
  }, []);

  // Barge-in gate: when the user takes the floor (a new submit, or a mic capture opening), silence
  // in-flight TTS AND drop confirmations still composing (composeSpokenConfirmation can take
  // seconds — stopping the provider can't cancel text it hasn't been handed yet).
  const speechGate = useMemo(
    () =>
      createSpeechGate({
        speak: (text, opts) => speak?.(text, opts),
        stop: () => stopSpeaking?.(),
      }),
    [speak, stopSpeaking],
  );

  const {
    busy,
    progress,
    pending,
    clarify,
    providerNotice,
    getModelCaller,
    submitQuery,
    applyPending,
    cancelPending,
    cancelClarify,
    dismissProviderNotice,
    onClarifyPick,
  } = useCanvasNlCommandController({
    nodes,
    edges,
    cwd,
    callModel,
    projects: projectRefs,
    activeProjectId: nav?.activeProjectId ?? undefined,
    previousProjectId,
    runCommand,
    runApp,
    speechGate,
    onCommandDelivery,
    setTrace,
    setText,
  });

  // Mode switching is hotkey-only and remappable in Canvas Settings → Hotkeys; the mic runs Auto.
  // No visible mode chip. Canvas Voice Context is still read per capture inside beginVoice.

  const {
    hasCommandVerb,
    buildDictationText,
    dispatchDictation,
    writeAgentPrompt,
    insertTerminalDictation,
    runTransform,
    submitTerminal,
    getDecoderContext,
  } = useCanvasVoiceRoutes({
    nodes,
    callModel,
    getModelCaller,
    voiceAccuracy,
    onCommandDelivery,
    setTrace,
    setText,
  });

  // Prompt polish for a live-voice dispatch: direct HTTP only. The cold `claude --print` fallback is
  // a multi-second spawn, and this call sits on the critical path of a spoken turn *behind* the
  // transcript grace-wait — stacking it there is how a polish step becomes a conversational stall.
  // The compose stage fails open to the user's own de-framed words, so refusing the fallback costs
  // polish and nothing else.
  // An injected `callModel` (tests, embedders) is used verbatim — it carries no transport semantics.
  const liveDispatchModel = useCallback(
    (prompt: string) =>
      callModel
        ? callModel(prompt)
        : getModelCaller().call(prompt, undefined, { allowCliFallback: false }),
    [callModel, getModelCaller],
  );
  const activeProjectMeta = navProjects?.find((project) => project.id === navActiveProjectId) ?? null;
  const { live, strip, liveTools, voiceToolTrace, voiceDiagnosticsCopyState, copyVoiceDiagnostics } = useCanvasLiveVoiceController({
    nodes,
    cwd,
    projectName: activeProjectMeta ? projectDisplayName(activeProjectMeta) : null,
    callModel: liveDispatchModel,
    projects: projectRefs,
    activeProjectId: nav?.activeProjectId ?? undefined,
    previousProjectId,
    runCommand,
    runApp,
    onCommandDelivery,
    setTrace,
  });
  // Report the session state through the Live Voice status context, so the narration channel and the
  // Speaker Queue go quiet while the user is talking to Lotus directly (and stay out of the open mic).
  useReportLiveVoiceActive(live.active);
  // Spoken text placed in the bar asks for the caret, but the field is only mounted again once the
  // listening row steps aside. The request waits for it.
  const focusPendingRef = useRef(false);
  const focusInput = useCallback(() => {
    if (inputRef.current) inputRef.current.focus();
    else focusPendingRef.current = true;
  }, []);
  const {
    stt,
    phase: turnPhase,
    held,
    heldPrompt,
    captureRoute,
    keptFor,
    cancelRecording,
    submitTyped,
    turnLive,
    voiceOpen,
    sendHeldPrompt,
    clearHeldPrompt,
    onMic,
    toggleLive,
  } = useCanvasTurnVoiceController({
    nodes,
    busy,
    live,
    speechGate,
    setTrace,
    text,
    setText,
    focusInput,
    hasCommandVerb,
    cleanUpDictation: (dictated, signal) => buildDictationText(dictated, true, signal),
    submitQuery,
    dispatchDictation,
    writeAgentPrompt,
    insertTerminalDictation,
    submitTerminal,
    runTransform,
    liveTools,
    getDecoderContext,
    onSpectrum,
  });
  // Text typed before Live Voice started waits out the session and comes back on End; the summary
  // line is what is left of the session afterwards.
  const liveSession = useLiveVoiceSession({
    active: live.active,
    phase: live.phase,
    actions: strip.actions,
    stash: { read: () => text, write: setText },
    // A spoken turn on its way. Typed ones say so in `submit` (their phase reads idle).
    sending: turnPhase === "delivering",
  });
  // Typed Enter. It runs through the Push-to-Talk session, so a second Enter while the first is in
  // flight is refused — the same guard a spoken command uses.
  const submit = useCallback(() => {
    if (!text.trim() || busy) return;
    liveSession.noteSend();
    // Refused while another turn is open. Say why — the text stays for the next Enter.
    if (submitTyped(text)) return;
    setTrace({
      text: voiceOpen ? "Voice input is still running — stop or cancel it (Esc) first." : "Still working on the last command — try again in a moment.",
      tone: "error",
    });
  }, [busy, liveSession.noteSend, submitTyped, text, voiceOpen]);
  // Enter in the empty bar sends a Held Prompt, Escape clears it (ADR-0064). A refusal says why.
  const actOnHeldPrompt = useCallback((action: () => { ok: true } | { ok: false; reason: string }) => {
    const outcome = action();
    if (!outcome.ok) setTrace({ text: outcome.reason, tone: "error" });
  }, []);
  const { polish: showPolish } = useVoiceInputSettings();
  const manualPolish = useManualDictationPolish({
    text,
    blocked: busy || live.active || stt.starting || stt.recording || stt.transcribing,
    build: buildDictationText,
    setText,
  });

  // Reset the FX to its resting drift the moment capture ends, so a stale last frame can't freeze
  // the border mid-shimmer. CSS also gates the spectrum on data-voice=recording; this is the cleanup.
  useEffect(() => {
    if (stt.recording) return;
    for (let band = 0; band < SPECTRUM_BAND_COUNT; band++) inputRowRef.current?.style.removeProperty(`--voice-band-${band}`);
    const el = fxRef.current;
    el?.style.removeProperty("--nl-spectrum");
    el?.style.removeProperty("--nl-level");
    el?.style.removeProperty("--nl-onset");
    onsetStateRef.current = null; // a fresh capture must not inherit the previous one's onset/level
  }, [stt.recording]);

  // The listening row (Push-to-Talk, the shared voice parts): while the mic is open or the words are
  // being transcribed, the heard words replace the field — typed text first, the live words after.
  const { listening, settling, voiceRow, heard, waveInline, waveTrailing } = useListeningRow(turnPhase, stt.interim, text);
  const pushToTalkKey = useVoiceKeyLabel("push-to-talk");
  const liveVoiceKey = useVoiceKeyLabel("live-voice");
  // Recording only: while the mic is still opening, ⌘Enter has no turn to finish yet.
  // The field leaves while the row shows. If it had the caret, the row takes it — or the engaged bar
  // (`:focus-within`) would fall back to its resting look mid-sentence — and hands it back after.
  const liveRowRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (!voiceRow || !focused) return;
    liveRowRef.current?.focus();
    focusPendingRef.current = true;
    // `focused` is read, not followed: only the moment the row appears matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceRow]);

  // Grow the input with its content (single line → multiline), capped so a long dictation scrolls
  // inside the bar instead of pushing it off-screen. Portable auto-size (WKWebView lacks field-sizing).
  // Also flag multiline so the row can bottom-pin its controls while staying centered on one line.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, NL_INPUT_MAX_HEIGHT_PX);
    el.style.height = `${next}px`;
    setInputMultiline(el.scrollHeight > NL_INPUT_SINGLE_LINE_PX);
    if (focusPendingRef.current) {
      focusPendingRef.current = false;
      el.focus();
    }
  }, [text, voiceRow, inputWidth]);

  // Auto-dismiss a result/feedback after a few seconds so the bar returns to its clean resting state
  // instead of holding the last message forever. Live states (recording/transcribing) aren't traces.
  useEffect(() => {
    if (!trace) return;
    const t = window.setTimeout(() => setTrace(null), TRACE_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [trace]);

  // ⌘K, merged in (2026-08-28). The command sheet reads THIS bar's text as its query and hangs
  // above the input row — there is no second input and no second catalog any more. `nav` is the
  // same app-effect channel the NL/voice intents resolve against, so a row and a spoken command
  // reach the identical code path.
  const sheet = useCanvasCommandSheet({
    query: text,
    nodes,
    nav,
    runCommand,
    onDispatchSession,
    // The escape hatch row: hand the raw words to the pipeline the bar has always used.
    onSend: () => { void submit(); },
    onClearQuery: () => setText(""),
    // A live voice session replaces the input outright, and a submit in flight is already
    // consuming the query — in both the sheet has nothing to act on. `busy` is excluded on purpose: it is the parse round-trip, and closing the sheet
    // mid-parse would yank the list out from under a user who is still reading it.
    enabled: !live.active && !pending && !clarify,
    onInvoke: () => {
      // ⌘K from a live voice session ends it first: the shortcut must never be a no-op, and the
      // bar it targets does not exist until the session closes.
      if (live.active) live.stop();
      inputRef.current?.focus();
    },
  });

  // Errors get a dedicated alert (below); everything else (live states, ok results) rides in the
  // hint line, shown only while the field is empty.
  const isError = trace?.tone === "error";
  // The one status the bar has to say right now, or null when it has nothing to report. Split out
  // from `placeholder` so the hint rotator can tell "a status owns the line" from "idle" — when this
  // is non-null the rotation must stop and hand the line over.
  // The Composer Target: where Enter sends what is in the field now — or, while the mic is open, the
  // words heard so far — read off the router's fast path (no model call). A capture reads it from
  // focus as it was when the mic opened, and text kept in the bar from the node it was spoken to:
  // that is where each goes.
  const targetText = stt.recording && stt.interim ? stt.interim : text;
  const liveActive = live.active;
  const composerTarget = useMemo(() => {
    if (liveActive) return null;
    const target = composerTargetFor(
      targetText,
      captureRoute?.context ?? buildCanvasVoiceContextFromNodes(nodes, agentStatusRegistry.list(), keptFor ?? undefined),
      { hasCommandVerb, addressedTerminal: (words) => resolveAddressedCanvasTerminalText(words, nodes) },
      captureRoute?.forcedMode ?? undefined,
    );
    if (target.to === "lotus") return { label: "Lotus", decides: target.decides, locked: false };
    // Kept for a node focus has since left: Enter still goes there, and the lock says so.
    const locked = !captureRoute && !!keptFor && !nodes.some((node) => node.selected && node.id === keptFor.id);
    return { label: target.name, decides: false, locked };
  }, [liveActive, targetText, captureRoute, keptFor, nodes, hasCommandVerb]);
  // A Held Prompt owns the empty bar's line: that is when Enter and Escape act on it.
  const heldPromptNote = heldPrompt ? `In ${heldPrompt.name}'s prompt · Enter to send · Esc to clear` : null;
  // The listening row carries its own live copy; the hint line has nothing to add while it shows.
  const statusText = busy
    ? (progress ?? "Thinking…")
    : voiceRow
      ? null
      : heldPromptNote
          ? heldPromptNote
          : trace && !isError
            ? trace.text
            : null;
  // The textarea keeps a real `placeholder` attribute for assistive tech even though CSS paints it
  // transparent — the visible copy is the hint layer, which can animate (a ::placeholder cannot).
  const placeholder = statusText ?? "Ask or command…";
  const placeholderTone = stt.recording
    ? "live"
    : busy
      ? "think"
      : !stt.transcribing && trace && !isError
        ? trace.tone
        : undefined;

  // The rotating hint (replaces the constant "Ask or command…"): phrases are built from THIS board —
  // the agents on it, whether one is running, a live note selection, the other open projects — so the
  // bar teaches its own grammar with the user's own names instead of a generic string.
  const hintPhrases = useMemo(() => {
    return buildNlHintPhrases({
      agentNames: agentStatusRegistry.list().map((a) => a.name),
      nodeCount: nodes.length,
      // Same rule the Canvas Voice Context uses for a `transform` outcome — a selected note with a
      // live, non-empty selection. Keeping the two in step is what stops the bar suggesting
      // "rewrite this shorter" when nothing is actually selected.
      hasNoteSelection: nodes.some(
        (n) => n.selected && n.type === "note" && noteSelectionRegistry.selectedText(n.id).length > 0,
      ),
      otherProjectNames: (projectRefs ?? [])
        .filter((p) => p.id !== navActiveProjectId)
        .map((p) => p.name),
    });
  }, [nodes, projectRefs, navActiveProjectId]);
  useNlHintRotator({
    slotRef: hintSlotRef,
    phrases: hintPhrases,
    // A status owns the line outright — nothing rotates underneath it.
    pinned: statusText,
    // Freeze whenever the user has the floor or a dialog is up. The rotator additionally stops itself
    // when the window is hidden.
    suspended: focused || text.length > 0 || !!pending || !!clarify || live.active || voiceRow,
  });

  // Error alert placement: above the bar when there's room overhead, otherwise beside it (right if the
  // viewport allows, else left). Measured against the bar's position so it adapts to where the bar sits.
  const [alertPlacement, setAlertPlacement] = useState<"above" | "right" | "left">("above");
  useLayoutEffect(() => {
    if ((!isError && !providerNotice) || !barRef.current || typeof window === "undefined") return;
    const frame = window.requestAnimationFrame(() => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.top >= 48) setAlertPlacement("above");
      else if (window.innerWidth - rect.right >= 240) setAlertPlacement("right");
      else setAlertPlacement("left");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isError, providerNotice, trace]);

  const recoverProvider = useCallback(async () => {
    if (!providerNotice) return;
    if (providerNotice.kind !== "cli-auth") {
      nav?.onOpenSettings();
      dismissProviderNotice();
      return;
    }

    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText("claude /login");
        copied = true;
      } catch {
        // Clipboard access can be blocked by the host. The terminal is still a useful recovery path.
      }
    }
    runCommand({ kind: "create-node", nodeType: "terminal", focus: true });
    dismissProviderNotice();
    setTrace({
      text: copied ? "Login command copied. Paste it in the new terminal." : "Terminal opened. Run claude /login to sign in.",
      tone: "ok",
    });
  }, [dismissProviderNotice, nav, providerNotice, runCommand]);

  return (
    <div
      ref={barRef}
      className="canvas-nl-bar nodrag nopan nowheel"
      data-canvas-delivery-source="nl-command"
      data-docked={docked ? "true" : undefined}
      data-rest={commandBarRest}
      style={docked
        ? ({ "--canvas-nl-frames-extra": `${(BRAND_SLOT_REM + (frameSwitcher ? frameSwitcherSlotCount(frameSwitcher.chips.length, frameSwitcher.overflow.length) * FRAME_SLOT_REM : 0)).toFixed(2)}rem` } as React.CSSProperties)
        : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        manualPolish.cancel();
        if (turnLive) {
          e.stopPropagation();
          cancelRecording();
        } else if (heldPrompt) {
          e.preventDefault();
          e.stopPropagation();
          actOnHeldPrompt(clearHeldPrompt);
        }
      }}
    >
      {pending && (
        <div className="canvas-nl-confirm" role="alertdialog" aria-label="Confirm destructive command">
          <span className="canvas-nl-confirm-text">{summarizeResolutions(pending).trace}?</span>
          <button
            type="button"
            className="canvas-nl-confirm-yes"
            onClick={() => {
              applyPending();
            }}
          >
            Confirm
          </button>
          <button
            type="button"
            className="canvas-nl-confirm-no"
            onClick={() => {
              cancelPending();
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {/* Conversational repair (Option C): an ambiguous target asks which node instead of dead-ending.
          Reuses the confirm chrome; each candidate is a pick that re-runs the pending intent. */}
      {!pending && clarify && (
        <div className="canvas-nl-confirm" role="alertdialog" aria-label="Disambiguate target">
          <span className="canvas-nl-confirm-text">{clarify.question}</span>
          {clarify.candidates.map((c) => (
            <button key={c.id} type="button" className="canvas-nl-confirm-yes" onClick={() => void onClarifyPick(c.id)}>
              {c.label}
            </button>
          ))}
          <button type="button" className="canvas-nl-confirm-no" onClick={cancelClarify}>
            Cancel
          </button>
        </div>
      )}
      {/* Errors get a dedicated minimal alert (role=alert), placed above the bar when there's room and
          beside it when there isn't. Non-error feedback rides in the input placeholder below. */}
      {!pending && isError && trace && !providerNotice && (
        <div className="canvas-nl-alert" data-placement={alertPlacement} role="alert">
          {trace.text}
        </div>
      )}
      {!pending && providerNotice && (
        <div className="canvas-nl-alert canvas-nl-provider-notice" data-placement={alertPlacement} role="alert">
          <span className="canvas-nl-provider-notice__copy">
            <strong>{providerNotice.title}</strong>
            <span>{providerNotice.detail}</span>
          </span>
          <button
            type="button"
            className="canvas-nl-provider-notice__action"
            aria-label={providerNotice.kind === "cli-auth" ? "Copy login command and open terminal" : "Open model settings"}
            onClick={() => void recoverProvider()}
          >
            {providerNotice.kind === "cli-auth" ? <TerminalSquare size={13} aria-hidden /> : <Settings size={13} aria-hidden />}
            {providerNotice.kind === "cli-auth" ? "Open login terminal" : "Open settings"}
          </button>
          <button
            type="button"
            className="canvas-nl-provider-notice__dismiss"
            aria-label="Dismiss provider notice"
            onClick={dismissProviderNotice}
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      )}
      {/* Visually-hidden live region for non-error status/results (the visible form is the placeholder);
          keeps screen readers announcing them with no visible chrome. */}
      {!pending && (stt.recording || stt.transcribing || heldPromptNote || (trace && !isError)) && (
        <span className="canvas-nl-sr" role="status" aria-live="polite">
          {stt.recording
            ? stt.interim || "Listening…"
            : stt.transcribing
              ? "Transcribing…"
              : heldPromptNote ?? trace?.text}
        </span>
      )}
      {live.active && voiceToolTrace && isVoiceToolTraceEnabled() && (
        <div className="canvas-voice-tool-trace" data-ok={voiceToolTrace.ok ? "true" : "false"} role="status" aria-live="polite">
          <span className="canvas-voice-tool-trace__tool">{voiceToolTrace.tool}</span>
          {voiceToolTrace.contextVersion && <span>ctx v{voiceToolTrace.contextVersion}</span>}
          {voiceToolTrace.heardTarget && <span>heard {voiceToolTrace.heardTarget}</span>}
          {voiceToolTrace.resolvedTarget && <span>→ {voiceToolTrace.resolvedTarget}</span>}
          {voiceToolTrace.preview && <span className="canvas-voice-tool-trace__preview">“{voiceToolTrace.preview}”</span>}
          <span>{voiceToolTrace.ok ? voiceToolTrace.speak || "done" : voiceToolTrace.error || "failed"}</span>
          <button
            type="button"
            className="canvas-voice-tool-trace__copy"
            aria-label="Copy voice diagnostics"
            title="Copy sanitized voice diagnostics"
            onClick={() => void copyVoiceDiagnostics()}
          >
            <Copy size={11} aria-hidden />
            {voiceDiagnosticsCopyState === "copied" ? "Copied" : voiceDiagnosticsCopyState === "empty" ? "Empty" : voiceDiagnosticsCopyState === "failed" ? "Unavailable" : "Copy"}
          </button>
        </div>
      )}
      {/* The "veil" resting design's floor: a gradient anchored to the window edge that carries the
          text while the bar itself has no chrome. Always rendered; CSS shows it only for that design
          (a floating feathered scrim reads as a smudge — anchoring it to the edge is what makes it
          read as deliberate). Pointer-transparent. */}
      <div className="canvas-nl-veil" aria-hidden="true" />
      {/* The ⌘K sheet. A child of the bar rather than a fixed overlay: .canvas-nl-bar is already a
          flex column whose children stack above the input row (the confirm and alert rows use the
          same slot), so the sheet tracks the bar's width, position and docked layout for free —
          and it can never drift away from the input it belongs to. */}
      {sheet.open && (
        <CanvasCommandSheet
          items={sheet.items}
          activeIndex={sheet.activeIndex}
          query={text}
          grouped={sheet.grouped}
          onHover={sheet.setActiveIndex}
          onRun={(index) => sheet.run(index)}
        />
      )}
      {/* The Live Voice strip, attached above the input row while a session runs (ticket 09). */}
      {live.active ? (
        <LiveVoiceStrip turns={strip.turns} provider={live.providerName} startedAt={liveSession.startedAt} />
      ) : null}
      <div
        ref={inputRowRef}
        className="canvas-nl-input-row"
        data-voice={stt.recording ? "recording" : stt.transcribing ? "transcribing" : undefined}
        data-multiline={inputMultiline ? "true" : undefined}
        data-target={composerTarget || live.active ? "true" : undefined}
      >
        {/* Listening-border FX: a masked hairline ring whose arcs light up with the live voice spectrum
            (written to CSS vars by onSpectrum) + an unmasked box-shadow halo. Pointer-transparent
            overlay — never intercepts input. Both children are single static-layer elements: no nested
            rotor, no CSS transform animation — the WKWebView-safe shape (see canvas-nl-listening-fx.css). */}
        <div className="canvas-nl-fx" ref={fxRef} aria-hidden="true">
          <span className="canvas-nl-fx-halo" />
          <span className="canvas-nl-fx-ring" />
        </div>
        {live.active ? (
          <LiveVoiceComposerRow
            phase={live.phase}
            agentSpeaking={live.agentSpeaking}
            health={live.health}
            error={live.error}
            // End ALWAYS returns to the default bar (even from an error) — no dead-end. Retry only
            // re-opens on error; the previous single-button retry trapped the user on a failing provider.
            onEnd={() => live.stop()}
            onRetry={() => void live.start()}
          />
        ) : (
          <>
            {composerTarget ? (
              <span className="canvas-nl-target">
                {listening ? (
                  <button
                    type="button"
                    className="ws-round-button"
                    data-variant="cancel"
                    aria-label="Cancel dictation"
                    title="Cancel (Esc)"
                    onClick={cancelRecording}
                  >
                    <X size={15} strokeWidth={2} />
                  </button>
                ) : null}
                <ComposerTargetLabel target={{ label: composerTarget.label, locked: composerTarget.locked }} />
                {/* The fast path could not place it. Said, not guessed: no agent is named here. */}
                {composerTarget.decides ? (
                  // Part of the chip, not a phrase in the text well where it read as a stale placeholder.
                  <span className="canvas-nl-target-note" title="No agent named — Lotus will decide">
                    auto<span className="sr-only">, Lotus will decide</span>
                  </span>
                ) : null}
              </span>
            ) : null}
            {/* The visible prompt copy. It lives here rather than in ::placeholder because a
                ::placeholder cannot be animated — the textarea keeps its real placeholder attribute
                for assistive tech and CSS paints that transparent. Pointer-transparent, and hidden
                outright once the user types so no ghost text sits behind their words. */}
            <div
              className="canvas-nl-hint"
              data-empty={text || voiceRow ? "false" : "true"}
              data-tone={placeholderTone}
              aria-hidden="true"
            >
              <span className="canvas-nl-hint-slot" ref={hintSlotRef}>
                <span className="canvas-nl-hint-line" data-phase="hold" />
                <span className="canvas-nl-hint-line" data-phase="in" />
              </span>
            </div>
            {voiceRow ? (
              <p
                ref={liveRowRef}
                className="ws-composer-live canvas-nl-live-row"
                data-settling={settling ? "true" : undefined}
                tabIndex={-1}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
              >
                {text.trim() ? <span className="ws-composer-live-typed">{text.trim()} </span> : null}
                {heard ? (
                  <span className="ws-composer-live-heard">{heard}</span>
                ) : waveInline ? (
                  <VoiceWave />
                ) : (
                  <span className="ws-composer-live-hint">
                    {turnPhase === "starting" ? "Opening the mic…" : settling ? "Transcribing…" : "Listening…"}
                  </span>
                )}
              </p>
            ) : (
              <textarea
                ref={setInput}
                className="canvas-nl-input"
                aria-label="Natural-language command"
                placeholder={placeholder}
                data-tone={placeholderTone}
                value={text}
                rows={1}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(e) => {
                  manualPolish.cancel();
                  setText(e.target.value);
                }}
                // Combobox semantics: this textarea is the input half, the sheet is the listbox half,
                // and focus never moves between them. Without aria-activedescendant a screen reader
                // would announce nothing as the arrow keys walk the rows.
                role="combobox"
                aria-expanded={sheet.open}
                aria-controls={CANVAS_SHEET_LISTBOX_ID}
                aria-autocomplete="list"
                aria-activedescendant={
                  sheet.open && sheet.items[sheet.activeIndex] ? sheetRowId(sheet.items[sheet.activeIndex].id) : undefined
                }
                onKeyDown={(e) => {
                  // The sheet gets first refusal on every key and reports whether it consumed one.
                  // Enter is why this ordering is not optional: with the sheet open it runs the
                  // active row, and the prose behind it must NOT also be submitted.
                  if (sheet.handleKeyDown(e)) return;
                  // Enter submits; Shift+Enter inserts a newline (multiline compose).
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    manualPolish.cancel();
                    if (heldPrompt && !text.trim()) {
                      liveSession.noteSend();
                      actOnHeldPrompt(sendHeldPrompt);
                    }
                    else void submit();
                  }
                }}
                disabled={busy}
              />
            )}
            {showPolish && text.trim() && !voiceRow && !stt.recording && !stt.transcribing && !stt.starting && (
              <button
                type="button"
                className="canvas-nl-icon"
                aria-label={manualPolish.polishing ? "Cancel text polish" : "Polish text"}
                title={manualPolish.polishing ? "Cancel text polish" : "Polish text — preserve meaning"}
                disabled={busy}
                onClick={() => manualPolish.polishing ? manualPolish.cancel() : void manualPolish.polish()}
              >
                {manualPolish.polishing ? <Loader2 size={15} className="canvas-nl-spin" /> : <Sparkles size={15} />}
              </button>
            )}
            {/* No keyboard-hint chip here: the slot's tooltips name ⌥⇧Space and ⌘⇧L, and Settings →
                Hotkeys lists the rest. The slot is the shared one (ticket 08): mic always, Live Voice
                while the field is empty, Send once there is text. */}
            <span className="canvas-nl-voice-actions">
              {waveTrailing ? <VoiceWave settled={settling} /> : null}
              {listening ? <VoiceTimer /> : null}
              <VoiceSlot
                voice={{
                  phase: turnPhase,
                  interim: stt.interim,
                  onToggle: onMic,
                  onCancel: cancelRecording,
                  hotkey: pushToTalkKey,
                  // Not "unavailable" while the provider list is still loading: that would flash on every mount.
                  available: stt.available || Boolean(stt.checking),
                  held,
                }}
                liveVoice={{ hotkey: liveVoiceKey, onStart: toggleLive }}
                empty={!text.trim()}
                sheetOpen={sheet.open}
                canSend={!!text.trim() && !busy}
                onSend={() => {
                  manualPolish.cancel();
                  void submit();
                }}
              />
            </span>
          </>
        )}
        {docked && (
          <div className="canvas-nl-docked">
            <span className="canvas-nl-docked-sep" aria-hidden />
            <CanvasDockedNav
              nav={{ ...docked, fallbackName: docked.fallbackName ?? cwd }}
              frameSwitcher={frameSwitcher}
              projectAdornment={machine ? <CanvasMachineStatus {...machine} placement="up" /> : null}
              cornerSlots={cornerSlots}
            />
          </div>
        )}
      </div>
      {liveSession.summary && !live.active ? (
        <LiveVoiceSummary text={liveSession.summary} onDismiss={liveSession.dismissSummary} />
      ) : null}
    </div>
  );
}
