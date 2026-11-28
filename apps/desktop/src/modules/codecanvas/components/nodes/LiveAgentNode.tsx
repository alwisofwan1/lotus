"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { useDroppable } from "@dnd-kit/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { createTerminalWebLinksAddon, terminalOscLinkHandler } from "@/lib/terminal-web-links";
import { activateWebglRenderer } from "@/modules/codespace/services/terminal-addons";
import {
  createFrameSampler,
  installTerminalPerfConsole,
  isTerminalPerfEnabled,
  terminalFramePerfProbe,
  terminalPerfProbe,
  type FrameSampler,
  resolveRendererKind,
} from "@/modules/codecanvas/services/terminal-perf-probe";
import { useCanvasTheme } from "@/modules/codecanvas/hooks/useCanvasTheme";
import { resolveTerminalFloor } from "@/modules/codecanvas/services/theme/terminal-floor";
import {
  ansiPaletteOrder,
  resolveCanvasTerminalTheme,
} from "@/modules/codecanvas/services/theme/canvas-terminal-theme";
import { getActiveProjectLocation } from "../../services/canvas-active-project";
import { machineKey } from "../../services/machine";
import { paintReattachedTerminalView } from "../../services/live-agent-terminal-paint";
import {
  createLiveAgentOutputScheduler,
  type LiveAgentOutputScheduler,
} from "../../services/live-agent-output-scheduler";
import { usePtySession } from "@/hooks/usePtySession";
import {
  CANVAS_TERMINAL_TYPOGRAPHY,
  forceFontFamilyRemeasure,
  isCanvasTerminalPrimaryFontLoaded,
  remeasureTerminalAfterFontLoad,
  resolveCanvasTerminalFontFamily,
} from "@/modules/codecanvas/services/canvas-terminal-typography";
import { handleTerminalCustomKeyEvent } from "@/modules/codespace/services/terminal-keybindings";
import { withTerminalClipboardKeys } from "@/modules/codespace/services/terminal-clipboard-keys";
import { resolveLiveAgentShiftEnterSequence } from "@/modules/codecanvas/services/live-agent-newline";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { useCanvasDropTarget } from "../../services/canvas-drop-target-store";
import { CanvasPtyViewport } from "./CanvasPtyViewport";
import { AgentPersonaHeader } from "./AgentPersonaHeader";
import { NodeConversationTitle } from "./NodeConversationTitle";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { useCanvasBehaviorSettings } from "../../hooks/useCanvasBehaviorSettings";
import { useCodeCanvasAgentMemoryPrompt } from "../../hooks/useCodeCanvasProjectMemory";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import { buildAgentRunnerAliases } from "../../services/canvas-agent-aliases";
import { agentIdentityRegistry } from "../../services/agent-identity-registry";
import { inputOpensTurn, paneTurnRegistry } from "../../services/pane-turn-registry";
import { liveAgentPresentation } from "../../services/live-agent-presentation";
import { shouldPublishStalled } from "../../services/stalled-guard";
import { noteAgentAsk } from "../../services/agent-ask";
import { paneAskBuffer } from "../../services/pane-ask-buffer";
import { recordSessionAsk, refineSessionTitle } from "../../services/session-activity";
import { agentTurnRegistry } from "../../services/agent-turn-registry";
import { runnerTurnCapability } from "../../services/runner-capability";
import { useAgentAnsweredAt, useAgentTurnFact } from "../../hooks/useAgentTurnFact";
import { useAgentHeadlines } from "../../hooks/useAgentHeadlines";
import { useFleetBriefing } from "../../hooks/useFleetBriefing";
import { isHookCapableRunner } from "../../services/voice/agent-done-callout";
import { voiceAgentOutputCorrelationRegistry } from "../../services/voice/voice-agent-output-correlation";
import { validateAgentName, type NameValidation } from "@/lib/agent-catalog";
import { buildLiveAgentSpawnSpec, matchCustomRunnerByCommand, resolveRunnerLaunch } from "../../services/live-agent-spawn";
import { resolveRunnerVisualIdentity } from "../../services/runner-visual-identity";
import { generatePaneTitle, type RunnerInfo } from "@/lib/tauri-api";
import { claudeSessionTailFor, claudeSessionsFor } from "../../services/remote-sessions";
import { capturesFromClaudeTranscripts, pickCapturableSessionId } from "../../services/session-capture";
import { destroyPersistentPty, hasPersistentPty, hasRunnerLaunched, markRunnerLaunched } from "@/lib/pty-session-pool";
import { canvasWritePersona } from "@/lib/tauri/codecanvas";
import { shouldStartDormant } from "../../services/session-dormancy";
import { resumeCapability } from "../../services/session-resume-capability";
import { agentSessionControlRegistry } from "../../services/session-control-registry";
import { canvasSessionStore } from "../../services/session-store";
import { CanvasDormantAgentCard } from "../sessions/CanvasDormantAgentCard";
import type { RelaunchIntent } from "../../services/session-relaunch";
import { needsYouConfirmText } from "../../services/session-verdict-copy";
import { createSessionControlHandle } from "../../services/session-control-handle";
import { useNodeSessions } from "../../hooks/useNodeSessions";
import { ChatAccountPicker, useClaudeAccountChoices } from "@/modules/chat/ui/ChatAccount";
import { CanvasNodeSessionList } from "../sessions/CanvasNodeSessionList";
import { runnerRegistryCache } from "@/lib/runner-registry-cache";
import {
  createLiveAgentLaunchController,
  canDispatchToLiveAgent,
  canQueueToLiveAgent,
  type LiveAgentLaunchPhase,
} from "../../services/live-agent-launch";
import {
  normalizeLiveAgentAnsi,
  type AnsiFoldState,
  type LiveAgentAnsiSurface,
} from "../../services/live-agent-ansi-normalizer";
import { filterLiveAgentTerminalInput } from "../../services/live-agent-terminal-input";
import { planLiveAgentPaste } from "../../services/live-agent-paste";
import { caretAnchorOffset } from "../../services/live-agent-caret-anchor";
import { createPtySubmitQueue, type PtySubmitQueue } from "../../services/pty-submit-queue";
import {
  enqueueLiveAgentStartupDispatch,
  flushLiveAgentDispatchBuffer,
} from "../../services/live-agent-dispatch-buffer";
import { canvasRuntimePaneId, canvasRuntimeScope } from "../../services/canvas-runtime-scope";
import { useAgentReplyRegistration } from "../../hooks/useAgentReplyRegistration";
import { useLiveAgentRunRegistration } from "../../hooks/useLiveAgentRunRegistration";
import { AGENT_DROP_PREFIX } from "../../hooks/useCanvasSkillDnd";
import type { CanvasAgentNodeData } from "../../types/canvas";
import { type AgentRunnerType, type RunnerSessionMode } from "@/lib/agent-runtime";

// After pasting the prompt, wait before sending Enter so the runner's bracketed-paste detection
// settles and registers the Enter as a real submit (not part of the paste). See live-agent-launch.
const SUBMIT_ENTER_DELAY_MS = 300;

// How often to poll ~/.claude/projects for the session id the runner created, so a reopened node can
// resume it (ADR-0027 Phase 5 capture). Claude writes the transcript on the first turn, so this keeps
// polling (cheaply) until a new session appears, then stops.
const SESSION_CAPTURE_POLL_MS = 3000;
// Stop polling after this many tries (~2 min). A live agent that hasn't produced a session by then
// is idle; we stop rather than poll the filesystem indefinitely.
const SESSION_CAPTURE_MAX_POLLS = 40;


/**
 * Safety-net quiet window: once a connected persona has sat in "awaiting-ready" with NO PTY output
 * for this long, we treat it as settled at the prompt and force it dispatchable (readiness banner
 * unrecognized). Settle-based rather than a fixed delay, so a slow boot that keeps streaming never
 * trips it — an idle agent emits no bytes (cursor blink is terminal-side), so genuine "at the prompt"
 * is the only state that stays quiet. See the fallback effect in {@link LiveAgentNode}.
 */
const LIVE_AGENT_READY_QUIET_MS = 4_000;

/**
 * A live Canvas Agent Node persona (ADR-0022): a persistent, watchable PTY running an agent CLI.
 * It spawns a shell, launches the runner via the Agent Runtime Kernel, waits for readiness, and
 * auto-submits the live operating prompt — all orchestrated by the pure launch controller. The PTY
 * surface is the shared `<CanvasPtyViewport>`; the header is the persona identity + coordination handle.
 */
export const LiveAgentNode = memo(function LiveAgentNode({ id, data, selected }: NodeProps) {
  const { name, model, cwd, permissionMode, runner, color, initialTask, resumeSessionId, account, projectId, onPersistSession, onSwitchSession, onSwitchAccount, hasSkillsNode, dispatchCommand, onClose } =
    data as CanvasAgentNodeData;
  // Set only by a spawn that chose one (the phone's summon sheet); the blank draft carries none.
  const effort = (data as Record<string, unknown>).effort as string | undefined;
  const runnerType: AgentRunnerType = runner ?? "claude";
  const runnerCommand = (data as Record<string, unknown>).runnerCommand as string | undefined;
  const dropActive = useCanvasDropTarget(id);
  const { allowAgentCanvasControl } = useCanvasBehaviorSettings();
  // Runner Registry config (ADR-0027 Phase 2/3) applied at launch: skip-permissions, extra flags, and
  // resume-on-reopen. `undefined` = still loading (gates the launch so the command reflects the saved
  // config); `null` = no entry / outside Tauri (fall back to defaults).
  const [runnerConfig, setRunnerConfig] = useState<RunnerInfo | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    // A custom runner's registry entry is keyed by a SPECIFIC id (e.g. "custom-acme"), not the
    // generic "custom" type stored on the node — so getRunner("custom") always misses, which used to
    // drop its config (skip-permissions, extra_flags, AND the claude_family flag). Match it by launch
    // command instead so a custom-but-Claude runner (e.g. `ccs acme …`) actually gets claude-family
    // treatment (peer messaging + model + resume). Built-in runners resolve by type as before.
    const resolve = async (): Promise<RunnerInfo | null> => {
      if (runnerType === "custom" && runnerCommand) {
        const { runners } = await runnerRegistryCache.listRunners();
        return matchCustomRunnerByCommand(runnerCommand, runners);
      }
      return runnerRegistryCache.getRunner(runnerType);
    };
    resolve()
      .then((cfg) => { if (active) setRunnerConfig(cfg); })
      .catch(() => { if (active) setRunnerConfig(null); });
    return () => { active = false; };
  }, [runnerType, runnerCommand]);

  const runnerIdentity = useMemo(
    () => resolveRunnerVisualIdentity({
      runner: runnerType,
      customRunner: runnerType === "custom" && runnerConfig
        ? {
            id: runnerConfig.id,
            name: runnerConfig.name,
            claudeFamily: Boolean(runnerConfig.claude_family),
          }
        : null,
    }),
    [runnerConfig, runnerType],
  );

  // Resume-on-reopen (ADR-0027 Phase 5). Enabled when the runner supports it AND the user hasn't turned
  // it off in Settings → Runners (default on). A persisted `resumeSessionId` means this node has launched
  // before → continue that session via `--resume`. We do NOT pre-mint with `--session-id` (Claude Code
  // ignores it); a fresh launch is bare and we CAPTURE the real id the CLI creates (see capture effect).
  // `resume_on_reopen` is the permission; the runner's session method is what makes it possible.
  // For a custom runner that method lives on its registry entry, so both are consulted (Slice 06).
  const capability = useMemo(
    () => resumeCapability(runnerType, runnerConfig),
    [runnerType, runnerConfig],
  );
  const resumeEnabled = capability.kind === "resume";
  const resumePlan = useMemo<{ id: string; mode: RunnerSessionMode } | null>(
    () => (resumeSessionId && resumeEnabled ? { id: resumeSessionId, mode: "resume" } : null),
    [resumeSessionId, resumeEnabled],
  );
  // A fresh launch on a resume-enabled runner: capture the session id the CLI creates so reopen resumes.
  // Capture diffs Claude's transcript dir, so only a Claude-family runner may use it.
  const shouldCaptureSession = !resumeSessionId && resumeEnabled
    && capturesFromClaudeTranscripts(runnerType, Boolean(runnerConfig?.claude_family));
  const assignedWorktreePath = (data as Record<string, unknown>).assignedWorktreePath as string | undefined;
  const runCwd = assignedWorktreePath || cwd;
  const projectMemory = useCodeCanvasAgentMemoryPrompt({ projectId, nodeId: id, limit: 16 });
  // This node's own conversations, for the header chip and its list (Session Widget, Slice 03).
  const nodeSessions = useNodeSessions(projectId, id, { activeProviderSessionId: resumeSessionId });

  const lodTier = useCanvasLodTier();
  const collapsed = lodTier !== "full";

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /** Set as soon as xterm is constructed. `termRef` only lands at markReady, which is a frame later. */
  const xtermRef = useRef<Terminal | null>(null);
  const webglAddonRef = useRef<{ dispose: () => void } | null>(null);
  const frameSamplerRef = useRef<FrameSampler | null>(null);
  const outputSchedulerRef = useRef<LiveAgentOutputScheduler | null>(null);

  // The opaque floor xterm paints on, and the palette built around it. Both derive from the
  // active Artisan theme, so a theme switch moves the terminal ground with everything else.
  const { theme: canvasTheme } = useCanvasTheme();
  const terminalTheme = useMemo(() => {
    const floor = resolveTerminalFloor(canvasTheme);
    return resolveCanvasTerminalTheme({ mode: canvasTheme.mode, background: floor.background });
  }, [canvasTheme]);
  // The same floor, handed to the ANSI normaliser so it can fold foregrounds an agent picked for
  // a black terminal. Read through a ref for the same reason terminalTheme is: `onOutput` is
  // installed once and must see the CURRENT theme, not the one that was active at mount.
  const ansiSurfaceRef = useRef<LiveAgentAnsiSurface>({ mode: "dark", floor: "" });
  ansiSurfaceRef.current = {
    mode: canvasTheme.mode,
    floor: resolveTerminalFloor(canvasTheme).background,
    // `foreground` is what dim is quietening: SGR 2 arrives with no colour of its own.
    foreground: terminalTheme.foreground,
    // The 16 slots xterm would paint, so the pale ones can be folded against the real ground
    // instead of being deepened in a palette that cannot see what is behind the glyph.
    palette: ansiPaletteOrder(terminalTheme),
  };
  // SGR is a state machine and a PTY splits wherever it likes, so the background in force has to
  // outlive the chunk that set it. One per pane, deliberately mutable and never in React state:
  // it changes on every read and nothing renders from it.
  const ansiFoldStateRef = useRef<AnsiFoldState>({});
  // The mount effect runs once (deps []) and must not remount on a theme change; it reads the
  // current palette through this ref, and the effect below keeps the live instance in sync.
  const terminalThemeRef = useRef(terminalTheme);
  terminalThemeRef.current = terminalTheme;
  const deliveryTargetRef = useRef<HTMLSpanElement>(null);
  const ptyWriteRef = useRef<((data: string) => void) | null>(null);
  const ptyWriteConfirmedRef = useRef<((data: string) => Promise<void>) | null>(null);
  const ptyResizeRef = useRef<((cols: number, rows: number) => void) | null>(null);
  const controllerRef = useRef<ReturnType<typeof createLiveAgentLaunchController> | null>(null);
  const startedRef = useRef(false);
  // Output that streamed BEFORE the launch controller existed. A direct-spawn CLI prints its
  // readiness banner the instant it starts — often before `pty.status` flips to "connected" and the
  // launch effect creates the controller. Without buffering, that banner is lost and readiness is
  // never detected → phase stays "awaiting-ready" → dispatch queues forever. Capped to the tracker's
  // window so it can't grow unbounded.
  const preArmBufferRef = useRef("");
  // Output that arrives before the xterm instance exists (reattach transcript replay races the
  // terminal mount effect) is held here and flushed into the terminal once it opens.
  const pendingXtermWriteRef = useRef("");
  // Timestamp of the last PTY output byte — drives the settle-based readiness fallback (below).
  const lastOutputAtRef = useRef(0);
  const submitQueueRef = useRef<PtySubmitQueue | null>(null);
  // Session-capture state (ADR-0027 Phase 5): the session ids that existed BEFORE this agent launched,
  // and a latch so we persist the captured id only once.
  const captureBaselineRef = useRef<Set<string> | null>(null);
  const capturedRef = useRef(false);
  /** Session ids a claim attempt reported as another node's, so later polls stop offering them. */
  const rejectedSessionIdsRef = useRef<Set<string>>(new Set());
  const [sessionListOpen, setSessionListOpen] = useState(false);
  /** A switch held by the handle because this node is waiting on a human; asked in the list. */
  const [pendingSwitch, setPendingSwitch] = useState<{ intent: RelaunchIntent; sessionId: string | null } | null>(null);
  /**
   * True from the moment a relaunch is requested until the node's pointer has actually changed.
   *
   * It feeds `hold`, which is what makes the whole move safe: the connect effect stops BEFORE the
   * pooled PTY is destroyed, and only resumes once the new pointer has round-tripped through the
   * board — so the effect never re-runs against a half-applied state, and never reattaches to the
   * process we just killed (`hooks/usePtySession.ts:116`).
   */
  const [relaunching, setRelaunching] = useState(false);
  /**
   * Decided once, and never re-derived: waking a node is a deliberate act, and nothing that happens
   * afterwards may put it back to sleep behind the user's back. The pooled-PTY check is what
   * distinguishes "reopened the app" from "came back to a project whose agent kept running".
   *
   * Decided when the registry entry lands rather than at mount, because a custom runner's resume
   * mechanism lives on that entry (Session Widget, Slice 06) and it arrives asynchronously. Judging
   * at mount meant reading `undefined` as "cannot resume", so a custom runner with a
   * `resume_template` never slept and launched its CLI unasked. Nothing spawns in the meantime: the
   * launch is already held while `runnerConfig === undefined` (see `hold` below), which is what
   * makes waiting free (`plans/codecanvas-session-refactor/issues/01`).
   */
  const [dormant, setDormant] = useState(false);
  const dormancyDecidedRef = useRef(false);
  useEffect(() => {
    if (dormancyDecidedRef.current || runnerConfig === undefined) return;
    dormancyDecidedRef.current = true;
    setDormant(
      shouldStartDormant({
        hasPooledPty: hasPersistentPty(canvasRuntimePaneId(projectId, id)),
        resumeSessionId,
        capability,
      }),
    );
  }, [runnerConfig, capability, resumeSessionId, projectId, id]);
  /** The pointer value we asked the board for, so the handshake knows when it has landed. */
  const pendingRelaunchRef = useRef<string | null>(null);
  // The account an account switch asked for; the hold also waits for it to arrive as props.
  const pendingAccountRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<LiveAgentLaunchPhase>("idle");
  const [outputStalled, setOutputStalled] = useState(false);
  const idleStalledRef = useRef(false);
  const statusRecoveryPendingRef = useRef(false);
  const [statusEvidenceVersion, setStatusEvidenceVersion] = useState(0);

  function clearOutputStall() {
    const registryIsStalled = agentStatusRegistry.list().some(
      (snapshot) => snapshot.id === id && snapshot.status === "stalled",
    );
    if (idleStalledRef.current) {
      idleStalledRef.current = false;
      setOutputStalled(false);
    }
    // The registry can outlive this component's local stall latch across HMR/remounts or be
    // overwritten by an external status writer. Fresh PTY output is authoritative liveness
    // evidence, so make the single publisher below reconcile that stale snapshot. Coalesce output
    // bursts until the publisher has consumed the revision.
    if (registryIsStalled && !statusRecoveryPendingRef.current) {
      statusRecoveryPendingRef.current = true;
      setStatusEvidenceVersion((version) => version + 1);
    }
  }

  // Paste text into the runner, then send Enter on a delay so the TUI's bracketed-paste mode
  // registers a real submit. Shared by the initial auto-submit AND dispatched tasks/messages.
  // Serialized: rapid back-to-back dispatches each get their own paste+Enter, in order.
  const submitToPty = useCallback((text: string) => {
    submitQueueRef.current ??= createPtySubmitQueue({
      write: (data) => {
        const writeConfirmed = ptyWriteConfirmedRef.current;
        if (!writeConfirmed) return Promise.reject(new Error("Live agent PTY is unavailable."));
        return writeConfirmed(data);
      },
      enterDelayMs: SUBMIT_ENTER_DELAY_MS,
    });
    return submitQueueRef.current.submit(text);
  }, []);

  const refreshPhase = useCallback(() => {
    const next = controllerRef.current?.phase ?? "idle";
    // A runner that reached ready/running is the only evidence that this pooled PTY holds an agent
    // and not a bare shell. Reattach reads it back before adopting — without it, a launch that
    // never came up left a shell in the pool that every later reattach adopted as a live agent
    // (`plans/codecanvas-session-refactor/issues/08`).
    if ((next === "ready" || next === "running") && persistKeyRef.current) {
      markRunnerLaunched(persistKeyRef.current);
    }
    setPhase(next);
  }, []);

  // The spawn spec is computed once from the node's config. CNVS-pure (ADR-0027): a launched runner
  // is just the CLI — no baked role/model. A concrete `initialTask` (from task dispatch) is the only
  // thing auto-submitted. Old persona fields (prompt/model/skills) are intentionally not fed here.
  const launch = useMemo(
    () =>
      resolveRunnerLaunch({
        nodePermissionMode: permissionMode,
        registrySkipPermissions: runnerConfig?.skip_permissions,
        registryExtraFlags: runnerConfig?.extra_flags,
      }),
    [permissionMode, runnerConfig],
  );

  /**
   * Where this node's persona lives on disk, once written.
   *
   * Only the TYPED launch needs it (a direct spawn passes the prompt as an argv element, which no
   * shell ever parses). Resume is the typed path, and typing ~3 KB overruns the tty's input queue:
   * the line discipline beeps and discards the tail, so the closing quote never lands
   * (`plans/codecanvas-session-refactor/issues/08`).
   */
  const [personaFile, setPersonaFile] = useState<string | null>(null);
  /**
   * Set when the persona could not be parked on disk, so the launch falls back to the inline
   * command instead of waiting forever. Without it the hold below never lifts and the node never
   * even spawns a PTY — a blank pane, which is worse than the bug being fixed.
   */
  const [personaFileFailed, setPersonaFileFailed] = useState(false);

  const spec = useMemo(
    () =>
      buildLiveAgentSpawnSpec({
        systemPromptFile: personaFile,
        runner: runnerType,
        runnerCommand,
        // Pin the model when one was chosen (e.g. NL "spawn a claude opus agent"); empty = CLI default.
        model: model || undefined,
        effort: effort || undefined,
        permissionMode: launch.permissionMode,
        // Per-runner extra flags from the Runner Registry (ADR-0027 Phase 3).
        extraFlags: launch.extraFlags,
        // Resume a stored session on reopen (ADR-0027 Phase 5); fresh launches are bare and captured.
        sessionId: resumePlan?.id,
        sessionMode: resumePlan?.mode,
        // A custom runner declares its own session method; built-ins carry none (Slice 06).
        resumeTemplate: runnerConfig?.resume_template,
        newSessionTemplate: runnerConfig?.new_session_template,
        task: initialTask,
        // A custom runner that is actually Claude (2nd account/profile wrapper) opts into full
        // claude-family treatment via its Runner Registry flag — so it gets --append-system-prompt
        // (identity + peer capability) and --model like any built-in claude runner.
        claudeFamily: runnerConfig?.claude_family,
        // Identity + voice overlay: thread this node's canvas handle (and a best-effort teammate
        // snapshot) into the system prompt so the agent owns its name and speaks in the house voice.
        // Role-free — no specialist role is forced (ADR-0027 stays runner-first).
        agentName: name,
        roster: agentStatusRegistry.list().filter((a) => a.id !== id).map((a) => a.name),
        // ADR-0030: teach the agent it can message teammates (system prompt, out-of-band).
        includePeerCapability: true,
        // Teach the agent it can drive the camera — only when the user opted in (Settings → Canvas).
        includeCanvasControlCapability: allowAgentCanvasControl,
        projectMemoryPrompt: projectMemory.prompt,
        projectMemoryBrief: projectMemory.brief,
      }),
    [id, name, runnerType, runnerCommand, model, effort, launch, resumePlan, initialTask, allowAgentCanvasControl, runnerConfig?.claude_family, runnerConfig?.resume_template, runnerConfig?.new_session_template, projectMemory.prompt, projectMemory.brief, personaFile],
  );



  // Bare relaunch command (no --resume) the controller falls back to if the resumed session is gone
  // (ADR-0027 Phase 5 hardening). Only needed when this launch is a resume.
  const fallbackCommand = useMemo(
    () =>
      resumePlan
        ? buildLiveAgentSpawnSpec({
            runner: runnerType,
            runnerCommand,
            permissionMode: launch.permissionMode,
            extraFlags: launch.extraFlags,
            task: initialTask,
            claudeFamily: runnerConfig?.claude_family,
            agentName: name,
            roster: agentStatusRegistry.list().filter((a) => a.id !== id).map((a) => a.name),
            includePeerCapability: true,
            includeCanvasControlCapability: allowAgentCanvasControl,
            projectMemoryPrompt: projectMemory.prompt,
            projectMemoryBrief: projectMemory.brief,
          }).command
        : undefined,
    [id, name, resumePlan, runnerType, runnerCommand, launch, initialTask, allowAgentCanvasControl, runnerConfig?.claude_family, projectMemory.prompt, projectMemory.brief],
  );

  /**
   * Direct (shell-less) spawn: the CLI is the PTY child, skipping the login shell boot and the
   * typed-command hop that costs the spawn its first seconds.
   *
   * **Resume goes through here too, since 2026-09-12.** It used to be forced onto the typed path so
   * its stale-session fallback would have a shell to relaunch in, and that one exception carried the
   * whole bug: a resume command is ~3 KB because the persona rides in `--append-system-prompt`, and
   * typing that into a shell overruns the tty's input queue — the line discipline beeps, discards
   * the tail, the closing quote never lands, and no CLI ever starts. argv has no shell, no quoting
   * and no queue, and it already carries the session flag. The fallback became a respawn instead of
   * a typed command (`plans/codecanvas-session-refactor/issues/08`).
   *
   * Still gated behind the resolved runnerConfig (the spec must be final). `null` argv (a custom
   * runner whose command carries shell syntax) falls back to the shell path automatically.
   */
  const directArgv = useMemo(
    () => (runnerConfig === undefined ? null : (spec.argv ?? null)),
    [runnerConfig, spec],
  );

  // Persist this agent's PTY across a project switch so switching away and back does NOT kill a
  // running agent (Bug B / ADR-0024 survive-unmount). Keyed per project+node; scoped per project so
  // closing a project tears down all of its agent PTYs. Gated on projectId — without one (tests,
  // detached use) the session keeps the original ephemeral abort-on-unmount behaviour.
  const agentPaneId = useMemo(() => (projectId ? canvasRuntimePaneId(projectId, id) : id), [projectId, id]);
  /**
   * Park the persona on disk before a TYPED launch, and hold the launch until it lands.
   *
   * Only the typed path needs it: a direct spawn hands the prompt to argv, where no shell and no
   * tty line discipline ever see it. `directArgv === null` is exactly "this launch will be typed",
   * and it is known before the PTY connects, so the hold costs nothing at steady state.
   */
  const needsPersonaFile = directArgv === null && Boolean(spec.systemPrompt);
  useEffect(() => {
    if (!needsPersonaFile || personaFile || personaFileFailed || !spec.systemPrompt) return;
    let alive = true;
    void canvasWritePersona(agentPaneId, spec.systemPrompt)
      .then((path) => { if (alive) setPersonaFile(path); })
      // A failed write must not strand the node: release the hold and launch with the inline
      // command, which still works for every persona short enough to type.
      .catch(() => { if (alive) setPersonaFileFailed(true); });
    return () => { alive = false; };
  }, [needsPersonaFile, personaFile, personaFileFailed, spec.systemPrompt, agentPaneId]);

  const persistKey = projectId ? agentPaneId : undefined;
  // Read through a ref so `refreshPhase` keeps a stable identity — it is a dependency of the launch
  // effect, and a new identity each render would re-run it.
  const persistKeyRef = useRef(persistKey);
  persistKeyRef.current = persistKey;
  const persistScope = useMemo(() => (projectId ? canvasRuntimeScope(projectId) : undefined), [projectId]);

  // The machine comes from the project, not from the node: one board, one host, published by
  // `useCanvasBoard` through `canvas-active-project`. A remote agent is an ordinary PTY whose child
  // is `ssh` (`lib/pty-session-controller.ts`), so nothing else in this component changes.
  const projectLocation = getActiveProjectLocation();
  // Value key, not identity: the singleton hands back a fresh object, and an identity dependency
  // would re-run every transcript read on each render.
  const projectMachineKey = machineKey(projectLocation);

  const pty = usePtySession({
    cwd: runCwd,
    location: projectLocation,
    // LOTUS_PANE_ID correlation: use a project-scoped pane id so stop hooks from a switched-away
    // project cannot collide with same node ids in the active project.
    paneId: agentPaneId,
    canvasTerminalId: id,
    command: directArgv,
    // An account names a Claude login; any other runner keeps the global one.
    claudeAccount: runnerType === "claude" ? account ?? null : null,
    persistKey,
    persistScope,
    // Wait for the Runner Registry config before connecting (cache makes this ~one render) —
    // otherwise the mount spawns a shell that is immediately killed and replaced by the direct
    // spawn once the config lands.
    // A dormant node holds forever until woken: no PTY is spawned, so it costs nothing at all.
    // `needsPersonaFile && !personaFile` joins the existing holds: a typed launch must not be typed
    // before the persona it names exists on disk.
    hold: runnerConfig === undefined || projectMemory.loading || relaunching || dormant || (needsPersonaFile && !personaFile && !personaFileFailed),
    onOutput: (chunk) => {
      lastOutputAtRef.current = Date.now(); // feeds the settle-based readiness fallback
      paneTurnRegistry.noteActivity(agentPaneId);
      clearOutputStall();
      voiceAgentOutputCorrelationRegistry.noteOutput(id, chunk);
      const displayChunk = normalizeLiveAgentAnsi(chunk, ansiSurfaceRef.current, ansiFoldStateRef.current);
      // PTY parsing/readiness stays immediate, but DOM rendering is bounded to one
      // combined xterm write per animation frame. Before the fitted renderer exists,
      // retain a bounded replay buffer for the initial paint/reattach path.
      if (outputSchedulerRef.current) outputSchedulerRef.current.push(displayChunk);
      else pendingXtermWriteRef.current = `${pendingXtermWriteRef.current}${displayChunk}`.slice(-256_000);
      const controller = controllerRef.current;
      if (controller) controller.observe(chunk);
      // Controller not created yet (still connecting): buffer so the launch effect can replay this
      // into the readiness tracker once it arms — see preArmBufferRef.
      else preArmBufferRef.current = `${preArmBufferRef.current}${chunk}`.slice(-16_000);
      refreshPhase();
    },
  });

  // Status and tone come from one seam (services/live-agent-presentation.ts): the launch phase and
  // PTY give the inferred value, and this pane's hook fact corrects it where the hook is
  // authoritative. Both answers together, so the badge can never disagree with what the fleet is
  // told. Dispatch is allowed once the runner is up.
  const turnFact = useAgentTurnFact(agentPaneId);
  // Only where the terminal is not: `collapsed` is `lodTier !== "full"`, and below zoom 0.5 the
  // PTY viewport is not rendered at all. At full zoom the answer is already on screen two lines
  // down (plans/agent-headlines/ Slice 4, option C).
  const headlineFor = useAgentHeadlines();
  // Also while the fleet briefing is on: that gesture exists precisely because the zoom rule makes
  // the answer unavailable when the operator is zoomed in on one node and wants to know what
  // everyone ELSE is doing (shift+F, plans/agent-headlines/ follow-on).
  const briefing = useFleetBriefing();
  const headline = collapsed || briefing ? headlineFor(agentPaneId) : undefined;
  const answeredAtMs = useAgentAnsweredAt(agentPaneId);
  const turnCapability = runnerTurnCapability(runnerType, runnerConfig?.claude_family);
  const presentation = liveAgentPresentation({
    phase,
    ptyEnded: pty.status === "ended",
    ptyError: pty.status === "error",
    fact: turnFact,
    capability: turnCapability,
    answeredAtMs,
    now: Date.now(),
  });
  const tone = presentation.tone;
  // Read through a ref by the relaunch path: a pane mid-question must be asked before its
  // conversation is swapped, and that check happens at click time, not render time.
  const needsYouRef = useRef(false);
  needsYouRef.current = presentation.status === "needs-you";
  const canReply = pty.status === "connected" && canDispatchToLiveAgent(phase);
  // The PTY shell is live (runner may still be starting): the node can accept a bounded dispatch
  // buffer now and flush it once ready, so a prompt sent during startup is not dropped.
  const accepts = pty.status === "connected" && canQueueToLiveAgent(phase);

  // Dispatch queueing: submit immediately when ready, otherwise buffer until the agent becomes ready.
  const canReplyRef = useRef(canReply);
  canReplyRef.current = canReply;
  const pendingDispatchRef = useRef<string[]>([]);
  const dispatchOrQueue = useCallback(
    (text: string) => {
      if (canReplyRef.current) return submitToPty(text);
      const rejected = enqueueLiveAgentStartupDispatch(pendingDispatchRef.current, text);
      if (rejected !== undefined) {
        return Promise.reject(new Error("Live agent startup dispatch buffer is full."));
      }
    },
    [submitToPty],
  );

  // Reuse the shared reply registry: a live persona accepts dispatched tasks/messages exactly like
  // headless agents do — so the team composer, NL command bar, and handoffs all drive it unchanged.
  // `insert` types into the prompt WITHOUT Enter (skill drop inserts /skill so the user can add context).
  useAgentReplyRegistration(id, canReply, dispatchOrQueue, undefined, (text) => ptyWriteRef.current?.(text), accepts);

  // Flush startup-buffered dispatches once the agent is ready. Keep every message as its own PTY
  // turn: joining separate voice/user intents into one prompt changes their meaning and gives only
  // one Enter receipt. The pure flusher waits for each native-confirmed submit before starting next.
  useEffect(() => {
    if (!canReply || pendingDispatchRef.current.length === 0) return;
    const queued = pendingDispatchRef.current.splice(0);
    let active = true;
    void flushLiveAgentDispatchBuffer(queued, submitToPty).then((result) => {
      if (active && result.failed.length > 0) setPhase("failed");
    });
    return () => { active = false; };
  }, [canReply, submitToPty]);

  // Keep stable refs to the latest PTY write/resize for the xterm + controller wiring. Every
  // input path (typing, submit queue, insert, paste) funnels through ptyWriteRef, so this is the
  // single choke point where a submit (Enter) opens the pane's turn window — the signal the
  // done-callout idle fallback is gated on (agent-done notify RCA).
  useEffect(() => {
    const write = pty.write;
    // A submit into this pane is the human acting on whatever it was asking about — approving,
    // rejecting, or just answering in prose. That is the only signal the rejection path leaves:
    // a denied tool never runs, so no `tool-post` fires, and Claude ends the turn without a `Stop`
    // (observed live 2026-08-25 — a pane stuck at `needs-you` for 200+ seconds).
    //
    // Gated on SUBMIT rather than any keystroke, deliberately. Clearing on arrow keys or a scroll
    // would hide a still-live prompt the moment the operator merely LOOKED at the pane — and since
    // a blocked agent emits nothing, nothing would ever raise it again. Staying visible one submit
    // too long is the recoverable error; going invisible while blocked is not.
    const noteHumanAnswered = (data: string) => {
      if (!inputOpensTurn(data)) return;
      agentTurnRegistry.noteAnswered(agentPaneId, Date.now());
      clearOutputStall();
    };
    // The ask, read from the write stream itself (`plans/agent-headlines/`). This choke point is the
    // only place that sees every input path, and — unlike the `prompt-submit` hook — it works for
    // runners that report nothing: codex, cursor, custom. It also catches MCP dispatches, which no
    // human types. Returns null while a line is still being composed.
    const noteAsk = (data: string) => {
      const ask = paneAskBuffer.note(agentPaneId, data);
      if (!ask) return;
      noteAgentAsk(agentPaneId, ask);
      // The same ask, made durable on the session row (`services/session-activity.ts`). Without
      // this the corner popover lists every conversation as "sesi baru" with no turns, forever —
      // the row is written at capture and nothing ever touched it again.
      rememberAskRef.current(ask);
    };
    ptyWriteRef.current = (data: string) => {
      paneTurnRegistry.noteInput(agentPaneId, data);
      noteHumanAnswered(data);
      noteAsk(data);
      write(data);
    };
    ptyWriteConfirmedRef.current = (data: string) => {
      paneTurnRegistry.noteInput(agentPaneId, data);
      noteHumanAnswered(data);
      noteAsk(data);
      return pty.writeConfirmed
        ? pty.writeConfirmed(data)
        : Promise.reject(new Error("Live agent PTY cannot confirm writes."));
    };
    ptyResizeRef.current = pty.resize;
  });

  // Shift+Enter → newline for the agent CLI. Read through a ref so the async-resolved registry
  // claude_family flag is honoured without restarting the xterm-mount effect.
  const shiftEnterSequenceRef = useRef(resolveLiveAgentShiftEnterSequence(runnerType, runnerConfig?.claude_family));
  shiftEnterSequenceRef.current = resolveLiveAgentShiftEnterSequence(runnerType, runnerConfig?.claude_family);

  /**
   * Point this node at another conversation and start its runner again (Session Widget, Slice 04).
   *
   * The order below is the whole safety of the move, and each step is load-bearing:
   *
   * 1. **hold first.** `usePtySession`'s connect effect re-runs on a `hold` change; holding stops it
   *    before the thing it is attached to disappears.
   * 2. **destroy the pooled PTY.** Without this the effect would find the key still pooled and
   *    REATTACH to the old CLI, handing the node new arguments and the previous process.
   * 3. **re-arm the launch guards.** They are one-shot per mount by design, and this is the one
   *    place that legitimately un-fires them. `capturedRef` and the baseline matter as much as
   *    `startedRef`: a fresh conversation writes a new transcript, and a stale baseline would make
   *    the capture think it had already seen it.
   * 4. **ask the board for the new pointer**, then release the hold only once that value has come
   *    back down as props — so the relaunch spawns against the arguments we actually intended.
   *
   * `rejectedSessionIdsRef` is deliberately NOT cleared: an id that belongs to another node still
   * belongs to it after a relaunch.
   */
  const commitRelaunch = useCallback(
    (intent: RelaunchIntent) => {
      // Judging happens in `createSessionControlHandle` now, before anything here runs — that split
      // is what makes `needs-you` enforceable (`plans/codecanvas-session-refactor/issues/02`).
      if (!onSwitchSession) return;

      const nextPointer =
        intent.kind === "resume" ? intent.session.providerSessionId ?? "" : "";

      setRelaunching(true);
      destroyPersistentPty(agentPaneId);
      startedRef.current = false;
      capturedRef.current = false;
      captureBaselineRef.current = null;
      preArmBufferRef.current = "";
      controllerRef.current = null;
      pendingRelaunchRef.current = nextPointer;
      onSwitchSession(id, intent.kind === "resume" ? intent.session.providerSessionId ?? null : null);
    },
    [onSwitchSession, agentPaneId, id],
  );

  // The other half of the handshake: the hold lifts only when the pointer we asked for has actually
  // arrived as props. Releasing it on a timer instead would race the board's state update and spawn
  // the runner against the OLD conversation.
  useEffect(() => {
    if (!relaunching || pendingRelaunchRef.current === null) return;
    if (pendingAccountRef.current !== null && account !== pendingAccountRef.current) return;
    if ((resumeSessionId ?? "") === pendingRelaunchRef.current) {
      pendingRelaunchRef.current = null;
      pendingAccountRef.current = null;
      setRelaunching(false);
      void nodeSessions.refresh();
    }
  }, [relaunching, resumeSessionId, account, nodeSessions]);

  /**
   * Move this node to another Claude account (mockups/account-picker-everywhere.html, decision 5):
   * the same sequence as `commitRelaunch`, keeping the conversation pointer and changing the account,
   * so the runner comes back with `--resume` on the new login. A dormant node has no process; it
   * only takes the account for its next start.
   */
  const switchAccount = useCallback(
    async (next: string) => {
      if (!onSwitchAccount) return;
      if (dormant) {
        onSwitchAccount(id, next);
        return;
      }
      setRelaunching(true);
      destroyPersistentPty(agentPaneId);
      startedRef.current = false;
      capturedRef.current = false;
      captureBaselineRef.current = null;
      preArmBufferRef.current = "";
      controllerRef.current = null;
      pendingRelaunchRef.current = resumeSessionId ?? "";
      pendingAccountRef.current = next;
      onSwitchAccount(id, next);
    },
    [onSwitchAccount, dormant, id, agentPaneId, resumeSessionId],
  );
  const [claudeAccounts, refreshAccounts] = useClaudeAccountChoices(account ?? null, Boolean(resumeSessionId));
  const currentAccount = account ?? claudeAccounts.find((a) => a.inUse)?.account ?? null;

  /**
   * Publish this node's session controls so the corner popover, ⌘K, and the cycle hotkeys can act on
   * it. Registered through refs so the handle identity stays stable — a handle that changed on every
   * render would churn the registry on a busy pane.
   */
  const dormantRef = useRef(dormant);
  dormantRef.current = dormant;
  const activeSession = nodeSessions.activeSessionId
    ? nodeSessions.sessions.find((s) => s.id === nodeSessions.activeSessionId)
    : undefined;
  const nodeSessionsRef = useRef(nodeSessions);
  nodeSessionsRef.current = nodeSessions;

  // The first reply settled on a title that is still the raw first ask: a model names it, once per
  // conversation, from the same transcript a Code pane is named from. Silent on failure — the ask
  // stays up, and Regenerate in the title menu is the manual retry.
  const previousStatusRef = useRef(presentation.status);
  const refinedRef = useRef(new Set<string>());
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = presentation.status;
    if (previous !== "running" || presentation.status === "running") return;
    if (!activeSession || activeSession.titleSource !== "prompt" || refinedRef.current.has(activeSession.id)) return;
    refinedRef.current.add(activeSession.id);
    const provider = runnerType === "codex" ? "codex" : "claude";
    void refineSessionTitle(canvasSessionStore, activeSession, async () => (await generatePaneTitle({ paneId: agentPaneId, provider })).title)
      .then((next) => { if (next) void nodeSessionsRef.current.refresh(); })
      .catch((error: unknown) => console.warn("[canvas] session title not refined:", error));
  }, [presentation.status, activeSession, runnerType, agentPaneId]);

  /**
   * Fold the operator's ask into the session row this node is running.
   *
   * Held in a ref because the write choke point is rebuilt on every render and must not carry a
   * stale session list. Silent on failure by design: a title is never worth disturbing a live agent
   * over, and the row is rewritten by the next ask anyway.
   */
  const rememberAskRef = useRef<(ask: string) => void>(() => {});
  /**
   * The ask made before the conversation had a row to write it to.
   *
   * Session-id capture works by diffing the CLI's transcript directory, and the CLI writes that
   * transcript in response to the FIRST prompt — so on a brand-new node the opening ask always
   * arrives before there is any session to attach it to. That ask is precisely the one worth
   * keeping: it is what the thread gets named after. Held here until the row appears.
   */
  const pendingAskRef = useRef<string | null>(null);
  const writeAsk = useCallback((ask: string) => {
    const { sessions, activeSessionId } = nodeSessionsRef.current;
    const active = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined;
    if (!active) {
      // Only the first unattached ask is held. A later one would overwrite the title the operator
      // will recognise the thread by, and the preview is refreshed from the live row anyway.
      pendingAskRef.current ??= ask;
      return;
    }
    const queued = pendingAskRef.current;
    pendingAskRef.current = null;
    void (async () => {
      let row = active;
      if (queued) row = await recordSessionAsk(canvasSessionStore, row, queued);
      const next = await recordSessionAsk(canvasSessionStore, row, ask);
      if (next !== active) void nodeSessionsRef.current.refresh();
    })().catch(() => {});
  }, []);
  rememberAskRef.current = writeAsk;

  // Flush the held opening ask the moment capture gives the conversation a row.
  useEffect(() => {
    if (!pendingAskRef.current) return;
    const { sessions, activeSessionId } = nodeSessions;
    const active = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined;
    if (!active) return;
    const queued = pendingAskRef.current;
    pendingAskRef.current = null;
    void recordSessionAsk(canvasSessionStore, active, queued)
      .then((next) => {
        if (next !== active) void nodeSessions.refresh();
      })
      .catch(() => {});
  }, [nodeSessions]);
  const relaunchRef = useRef(commitRelaunch);
  relaunchRef.current = commitRelaunch;
  const canSwitchRef = useRef(Boolean(onSwitchSession));
  canSwitchRef.current = Boolean(onSwitchSession);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const sessionControl = useMemo(
    () =>
      createSessionControlHandle({
        sessions: () => nodeSessionsRef.current.sessions,
        activeSessionId: () => nodeSessionsRef.current.activeSessionId,
        // A node the board cannot hand a new pointer to is as unrunnable as one with no project,
        // and `no-project` is the verdict that already says so.
        facts: () => ({
          projectId: canSwitchRef.current ? projectIdRef.current : null,
          activeSessionId: nodeSessionsRef.current.activeSessionId,
          awaitingAnswer: needsYouRef.current,
        }),
        isDormant: () => dormantRef.current,
        wake: () => setDormant(false),
        relaunch: (intent) => relaunchRef.current(intent),
      }),
    [],
  );
  useEffect(() => agentSessionControlRegistry.register(id, sessionControl), [id, sessionControl]);

  // The node list's press. `request` never kills a pane that is waiting on a human: it returns the
  // question, which the list asks inline, and only "Switch anyway" commits (refusals close quietly).
  const requestSwitch = (intent: RelaunchIntent, sessionId: string | null) => {
    const verdict = sessionControl.request(intent);
    if (verdict.allowed && "confirm" in verdict) setPendingSwitch({ intent, sessionId });
    else setSessionListOpen(false);
  };

  /**
   * Keep the session row's status honest about this node's process.
   *
   * Only the CAPTURE path used to write `live`, and capture never runs for a resume — so continuing
   * a conversation left its row saying "tersimpan" while it was demonstrably running, and the corner
   * popover kept offering to resume something that already had a CLI. The node is the only place
   * that knows the truth, so it says so.
   *
   * `status` stays a cache, never a durable fact: a force-quit writes nothing, which is what the
   * startup reconciliation exists to clean up.
   */
  useEffect(() => {
    if (!projectId || !resumeSessionId) return;
    const connected = pty.status === "connected";
    const ended = pty.status === "ended" || pty.status === "error";
    if (!connected && !ended) return;
    let active = true;
    void canvasSessionStore
      .list(projectId)
      .then(async (rows) => {
        if (!active) return;
        const row = rows.find((r) => r.nodeId === id && r.providerSessionId === resumeSessionId);
        if (!row) return;
        const next = connected ? "live" : row.status === "live" ? "resumable" : row.status;
        if (next === row.status) return;
        await canvasSessionStore.upsert({ ...row, status: next, lastActivityAt: Date.now() });
      })
      .catch(() => {
        // A status label is not worth disturbing a running agent over.
      });
    return () => { active = false; };
  }, [projectId, resumeSessionId, pty.status, id]);

  // The line a dormant card shows: read once, when the node comes up asleep. A node that is running
  // has its terminal, so this never runs for it.
  const [dormantPreview, setDormantPreview] = useState<{ text: string | null; loading: boolean }>({
    text: null,
    loading: false,
  });
  useEffect(() => {
    if (!dormant || !resumeSessionId) return;
    let active = true;
    setDormantPreview({ text: null, loading: true });
    // A remote agent's transcript lives on the machine that ran it, so the read follows the project
    // rather than assuming this disk.
    void claudeSessionTailFor(projectLocation, runCwd, resumeSessionId)
      .then((text) => { if (active) setDormantPreview({ text, loading: false }); })
      .catch(() => { if (active) setDormantPreview({ text: null, loading: false }); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projectMachineKey stands in for the machine
  }, [dormant, resumeSessionId, runCwd, projectMachineKey]);

  // Resume capture (ADR-0027 Phase 5). Snapshot the session ids that already exist for this cwd at
  // mount — before the runner launches — so the new transcript the CLI writes can be told apart.
  useEffect(() => {
    if (!shouldCaptureSession) return;
    let active = true;
    claudeSessionsFor(projectLocation, runCwd)
      .then((ids) => { if (active && captureBaselineRef.current === null) captureBaselineRef.current = new Set(ids); })
      .catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projectMachineKey stands in for the machine
  }, [shouldCaptureSession, runCwd, projectMachineKey]);

  // Once the runner is live, poll for the session id it created (written on the first turn) and
  // persist the first id not in the baseline, so the next reopen resumes it. Self-stops after capture
  // OR after a bounded window — an agent that never gets a turn writes no session, so we stop polling
  // rather than read the dir forever (avoids accumulating idle work).
  useEffect(() => {
    if (!shouldCaptureSession || pty.status !== "connected" || capturedRef.current) return;
    let timer: number | undefined;
    let attempts = 0;
    const tick = async () => {
      if (capturedRef.current) return;
      const baseline = captureBaselineRef.current;
      if (baseline) {
        const ids = await claudeSessionsFor(projectLocation, runCwd);
        // Skip ids a previous tick was told belong to another pane: two agents launched in the same
        // cwd both see the first new transcript as "new since my baseline" (Slice 07).
        const fresh = pickCapturableSessionId(ids, baseline, rejectedSessionIdsRef.current);
        if (fresh) {
          const accepted = await onPersistSession?.(id, fresh);
          if (accepted === false) {
            // Another node owns it. Remember that and keep polling — our own transcript may not
            // have appeared yet. Deliberately NOT marking captured: giving up here would leave this
            // pane resuming a conversation that is not its own on the next reopen.
            rejectedSessionIdsRef.current.add(fresh);
          } else {
            capturedRef.current = true;
            return;
          }
        }
      }
      if (++attempts >= SESSION_CAPTURE_MAX_POLLS) return; // give up; idle agent has no session to resume
      timer = window.setTimeout(tick, SESSION_CAPTURE_POLL_MS);
    };
    timer = window.setTimeout(tick, SESSION_CAPTURE_POLL_MS);
    return () => { if (timer) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projectMachineKey stands in for the machine
  }, [shouldCaptureSession, pty.status, runCwd, projectMachineKey, id, onPersistSession]);

  // Mount xterm into the shared viewport's host div (proven lifecycle, mirrors the Swarm panel).
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily: resolveCanvasTerminalFontFamily(),
      fontSize: CANVAS_TERMINAL_TYPOGRAPHY.fontSize,
      lineHeight: CANVAS_TERMINAL_TYPOGRAPHY.lineHeight,
      letterSpacing: CANVAS_TERMINAL_TYPOGRAPHY.letterSpacing,
      fontWeight: CANVAS_TERMINAL_TYPOGRAPHY.fontWeight,
      fontWeightBold: CANVAS_TERMINAL_TYPOGRAPHY.fontWeightBold,
      // OPAQUE floor (plans/canvas-terminal-opaque-floor). This used to be a transparent xterm
      // over the CSS ink-floor, which forced per-cell alpha compositing and pinned the node to
      // WebKit's DOM renderer — 30% of the webview main thread went to CoreText shaping and
      // WebCore layout, with JS at 4.2%. The floor colour comes from the same resolver the CSS
      // viewport uses, so the two cannot drift into a visible seam.
      theme: terminalThemeRef.current,
      allowTransparency: false,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      linkHandler: terminalOscLinkHandler,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    term.open(containerRef.current);
    term.unicode.activeVersion = "11";
    // Assigned here rather than at markReady: the WebGL and theme effects below run in the same
    // commit and need the instance before the post-fit rAF has landed.
    xtermRef.current = term;
    // fontsource ships font-display: swap — a node mounted on the first frame measures its glyph
    // cell against the fallback face and keeps that width until forced to re-measure. `disposed`
    // guards the async continuation against firing after cleanup already tore this term down.
    let disposed = false;
    let paintRaf = 0;
    if (typeof document !== "undefined" && document.fonts) {
      void remeasureTerminalAfterFontLoad({
        isPrimaryFontLoaded: isCanvasTerminalPrimaryFontLoaded,
        fontsReady: () => document.fonts.ready.then(() => undefined),
        isDisposed: () => disposed,
        // NOT a bare re-assign: xterm's option setter is guarded on `!==` and the resolved stack
        // is cached, so setting it back would be swallowed and the stale cell would survive.
        reapplyFontFamily: () => {
          forceFontFamilyRemeasure((family) => { term.options.fontFamily = family; });
        },
        refit: () => {
          try {
            fitAddon.fit();
            ptyResizeRef.current?.(term.cols, term.rows);
          } catch {
            /* container detached */
          }
        },
      });
    }
    // Measurement is opt-in (localStorage `lotus.terminal.perf`). A performance.now() pair per
    // write plus a permanent rAF loop is real cost on the exact path being optimised, so a
    // normal run must not pay it. See terminal-perf-probe.ts for the procedure.
    const perfEnabled = isTerminalPerfEnabled();
    if (perfEnabled) {
      // Idempotent: every node calls it, one report function survives.
      installTerminalPerfConsole(window);
      frameSamplerRef.current = createFrameSampler({
        probe: terminalFramePerfProbe,
        // Resolved per sample: a node can lose its GPU context mid-run and relabel itself.
        renderer: () => resolveRendererKind(containerRef.current),
      });
      frameSamplerRef.current.start();
    }
    // Route clicked URLs to the OS browser. A bare WebLinksAddon uses window.open(), which is a
    // no-op in the Tauri WKWebView, so links looked clickable but did nothing.
    term.loadAddon(createTerminalWebLinksAddon());
    // Size the grid + PTY BEFORE painting the buffered transcript. A reattached full-screen TUI's
    // replay uses absolute cursor positioning sized for the running PTY; writing it into xterm's
    // default 80×24 grid and then reflowing scrambles it (the project-switch garble bug). Until
    // markReady sets termRef, streaming output keeps buffering into pendingXtermWriteRef, so ALL
    // pre-fit output is flushed once into a correctly-sized grid.
    // Handle kept so cleanup can cancel it. Without that, a StrictMode remount (or any fast
    // unmount) leaves this frame queued against a terminal that cleanup already disposed: it
    // refits a dead grid and then schedules a reposition that reads `term.buffer`, which throws
    // once xterm has cleared its internals.
    paintRaf = requestAnimationFrame(() => {
      paintRaf = 0;
      paintReattachedTerminalView({
        fit: () => fitAddon.fit(),
        size: () => ({ cols: term.cols, rows: term.rows }),
        resizePty: (cols, rows) => ptyResizeRef.current?.(cols, rows),
        markReady: () => {
          termRef.current = term;
          outputSchedulerRef.current = createLiveAgentOutputScheduler({
            write: perfEnabled
              ? (batch) => {
                  frameSamplerRef.current?.noteActivity();
                  const started = performance.now();
                  // Callback form on purpose. `write()` queues the chunk and returns, so the
                  // elapsed time here is the PARSE cost — the paint lands later and shows up in
                  // the frame sampler instead. Measuring around the bare call would have
                  // reported the enqueue and missed everything this change actually touched.
                  term.write(batch, () => {
                    terminalPerfProbe.record({
                      ms: performance.now() - started,
                      chars: batch.length,
                      renderer: resolveRendererKind(containerRef.current),
                    });
                  });
                }
              : (batch) => term.write(batch),
          });
        },
        flushPending: () => {
          if (pendingXtermWriteRef.current) {
            term.write(pendingXtermWriteRef.current);
            pendingXtermWriteRef.current = "";
          }
        },
      });
      scheduleReposition();
    });

    // Pin the dispatch landing anchor to the live prompt caret. The node's bottom edge is a TUI status
    // footer, not the prompt — so we track the xterm cursor row and reposition the target span there.
    // rAF-throttled, driven by cursor moves + renders (and refits below).
    let repositionRaf = 0;
    const repositionDeliveryTarget = () => {
      repositionRaf = 0;
      // Belt and braces alongside the cancels in cleanup: this reads `term.buffer`, and under a
      // StrictMode remount the DOM refs below are still live (same nodes, re-run effect) while
      // THIS closure's terminal is already disposed — so a null-ref check cannot catch it.
      if (disposed) return;
      const span = deliveryTargetRef.current;
      const host = containerRef.current;
      const body = span?.parentElement;
      if (!span || !host || !body) return;
      const cursorEl = host.querySelector<HTMLElement>(".xterm-cursor");
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      const rows = term.rows || 1;
      const cellHeight = screen && screen.clientHeight > 0 ? screen.clientHeight / rows : 0;
      const bodyRect = body.getBoundingClientRect();
      const { top, height } = caretAnchorOffset({
        cursor: cursorEl ? cursorEl.getBoundingClientRect() : null,
        body: { left: bodyRect.left, top: bodyRect.top, width: bodyRect.width, height: bodyRect.height },
        fallback: { cursorY: term.buffer.active.cursorY, cellHeight },
      });
      span.style.top = `${top}px`;
      span.style.height = `${height}px`;
      span.style.bottom = "auto";
    };
    function scheduleReposition() {
      if (repositionRaf) return;
      repositionRaf = requestAnimationFrame(repositionDeliveryTarget);
    }
    // Only cursor moves change the caret's row within the body (content scroll keeps the prompt caret
    // put in a TUI); NOT onRender — that storms during an agent's output flood and forces a reflow
    // every frame right as the comet lands. Screen-position changes (drag/zoom) are handled by the
    // overlay re-measuring this span's rect each frame.
    const cursorDisposable = term.onCursorMove(scheduleReposition);

    const dataDisposable = term.onData((d) => {
      const input = filterLiveAgentTerminalInput(d);
      if (input !== null) ptyWriteRef.current?.(input);
    });
    // Text paste goes to the PTY explicitly bracket-wrapped, bypassing xterm's paste pipeline.
    // xterm only brackets a paste when THIS instance saw the CLI's one-shot `?2004h` enable — a
    // reattached instance may have missed it, and its raw `\r`s would submit the runner's prompt
    // instantly (paste-auto-submit bug). Capture phase, so it runs before xterm's own textarea
    // handler; image/empty pastes flow natively (plan = null).
    const pasteHost = containerRef.current;
    const handlePaste = (event: ClipboardEvent) => {
      const dt = event.clipboardData;
      if (!dt) return;
      const plan = planLiveAgentPaste({ types: [...dt.types], text: dt.getData("text/plain") });
      if (plan === null) return;
      event.preventDefault();
      event.stopPropagation();
      ptyWriteRef.current?.(plan);
    };
    pasteHost.addEventListener("paste", handlePaste, true);
    // Windows/Linux copy and paste keys first (Ctrl+C with a selection, Ctrl+V); paste then arrives
    // as the native paste event `handlePaste` above already brackets.
    term.attachCustomKeyEventHandler(withTerminalClipboardKeys(term, (event: KeyboardEvent) =>
      handleTerminalCustomKeyEvent(event, (d) => ptyWriteRef.current?.(d), undefined, {
        shiftEnterSequence: () => shiftEnterSequenceRef.current,
      }),
    ));
    // Debounced + size-guarded refit (mirrors the codespace runtime's guards): fit() is an
    // expensive xterm reflow, and an auto-arrange resizes EVERY node in the same frame — N
    // simultaneous refits stall the main thread and eat the glide/enter animation frames.
    // The trailing debounce + per-node jitter spreads the refits out AFTER the motion settles.
    let lastFitW = 0;
    let lastFitH = 0;
    let fitTimer: number | undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect && Math.abs(rect.width - lastFitW) < 1 && Math.abs(rect.height - lastFitH) < 1) return;
      if (rect) { lastFitW = rect.width; lastFitH = rect.height; }
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        try {
          fitAddon.fit();
          ptyResizeRef.current?.(term.cols, term.rows);
          scheduleReposition();
        } catch {
          /* container detached mid-resize */
        }
      }, 160 + Math.random() * 180);
    });
    observer.observe(containerRef.current);
    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      window.cancelAnimationFrame(paintRaf);
      window.cancelAnimationFrame(repositionRaf);
      observer.disconnect();
      pasteHost.removeEventListener("paste", handlePaste, true);
      cursorDisposable.dispose();
      dataDisposable.dispose();
      outputSchedulerRef.current?.dispose();
      outputSchedulerRef.current = null;
      termRef.current = null;
      xtermRef.current = null;
      frameSamplerRef.current?.stop();
      frameSamplerRef.current = null;
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      term.dispose();
    };
  }, []);

  // Keep the palette live without remounting the terminal. Rebuilding xterm on a theme switch
  // would drop the scrollback and re-run the reattach paint for every node on the board.
  useEffect(() => {
    const term = xtermRef.current;
    if (term) term.options.theme = terminalTheme;
  }, [terminalTheme]);

  // GPU acceleration for EVERY node, asked once at mount and never revisited.
  //
  // Two things were tried and rejected, both because a canvas shows many terminals side by side
  // and any node rendering differently from its neighbours is the visible bug:
  //
  //   • Tying eligibility to `selected` — focusing a terminal swapped it from the DOM renderer
  //     to WebGL and unfocusing swapped it back. The two rasterise glyphs differently, so box
  //     drawing and ASCII art visibly changed on every focus change.
  //   • Capping how many nodes may hold a GPU context — with 8 nodes and 6 slots, two rendered
  //     differently from the other six. Any cap produces that; the choice is all or none.
  //
  // `surface: "canvas"` opts out of the policy's blanket Tauri disable, which is about
  // CodeSpace's pane lifecycle. Without it this call is a silent no-op in the desktop app.
  //
  // The remaining risk is accepted: WKWebView limits live WebGL contexts, and a very large board
  // may have WebKit reclaim the oldest. That fires onContextLoss, the node falls back to the DOM
  // renderer, and it relabels itself so the difference is diagnosable instead of mysterious.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    let cancelled = false;

    const markRenderer = (renderer: "webgl" | "dom") => {
      if (containerRef.current) containerRef.current.dataset.renderer = renderer;
    };

    void activateWebglRenderer(term, {
      surface: "canvas",
      activePaneEligible: true,
      // Checked INSIDE the activator, after its dynamic import resolves. `cancelled` covers this
      // effect's own teardown; the xtermRef comparison covers the mount effect having disposed
      // and replaced the terminal underneath us (StrictMode's remount does exactly that).
      isStale: () => cancelled || xtermRef.current !== term,
      // The addon is already disposed when this fires. Drop our handle and relabel; do NOT
      // re-activate, which would be a renderer swap by another name.
      onLost: () => {
        webglAddonRef.current = null;
        markRenderer("dom");
      },
    }).then((addon) => {
      if (cancelled || !addon) {
        addon?.dispose();
        // Diagnostic, not decoration: when two nodes on one board render glyphs differently,
        // this is what says which renderer each one actually got — without guessing from pixels.
        if (!cancelled) markRenderer("dom");
        return;
      }
      webglAddonRef.current = addon;
      markRenderer("webgl");
    });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Once the PTY is live, launch the runner. In "command" mode the CLI is already the PTY child
  // (direct spawn) so the controller only arms the readiness watch; in "shell" mode it types the
  // launch command first. Guarded so it only fires once.
  useEffect(() => {
    // Wait for the Runner Registry config to resolve so the launch command reflects it (ADR-0027).
    if (pty.status !== "connected" || startedRef.current || runnerConfig === undefined) return;
    startedRef.current = true;
    const controller = createLiveAgentLaunchController({
      spec,
      runner: runnerType,
      launchMode: pty.mode === "command" ? "direct" : "typed",
      // Bracketed so the launch traffic never titles the card. Three things go through the same
      // choke point a human uses — the shell line that starts the runner, the persona bootstrap, and
      // the operator's task — and only the last is an ask. The persona is the one that bit: it is
      // TYPED IN for runners with no `--append-system-prompt` (`live-agent-spawn.ts:62`), i.e. codex
      // and custom, so the first Codex pane to get a headline was titled with the canvas preamble.
      // The real task is recorded below from the spec, precisely, rather than scraped back out.
      write: (text) => {
        paneAskBuffer.suspend(agentPaneId);
        try {
          ptyWriteRef.current?.(text);
        } finally {
          paneAskBuffer.resume(agentPaneId);
        }
      },
      // Held across the promise, not just the call: the submit queue writes the text and its Enter
      // separately, and a bracket that closed early would let that Enter submit the persona.
      submit: (text) => {
        paneAskBuffer.suspend(agentPaneId);
        void submitToPty(text)
          .catch(() => setPhase("failed"))
          .finally(() => paneAskBuffer.resume(agentPaneId));
      },
      // If the resumed session is gone, relaunch bare and clear the dead id so reopen starts fresh
      // and the capture effect re-arms (resumeSessionId "" → falsy → no resume next time).
      // Resume launches always come up in "shell" mode, so the typed fallback has a shell to use.
      fallbackCommand,
      // The resumed conversation is gone. Clear the dead pointer, then relaunch: a direct spawn has
      // no shell to type a bare command into, so recovery is a fresh process, not a fresh line.
      // `commitRelaunch` owns that sequence already — destroy the pooled PTY, re-arm the guards,
      // and ask the board for the new (empty) pointer.
      onResumeFailed: () => {
        onPersistSession?.(id, "");
        relaunchRef.current({ kind: "new" });
      },
    });
    controllerRef.current = controller;
    // The one piece of launch traffic that IS an ask, taken from the spec rather than the stream.
    // Stated here because this is where it is known for certain; recognising it among the launch
    // writes would mean guessing.
    if (initialTask?.trim()) noteAgentAsk(agentPaneId, initialTask.trim());
    if (pty.reattached && (!persistKey || hasRunnerLaunched(persistKey))) {
      // Reattached to a still-running agent after a project switch: the CLI is alive and already
      // ran its launch/initial turn. Re-arm dispatch WITHOUT re-typing the command or re-submitting
      // the initial task — the transcript replay restored the terminal view.
      //
      // Gated on evidence, not on the reattach alone: a pooled PTY whose launch never came up holds
      // a bare shell, and adopting that leaves the pane at a prompt forever with nothing to talk to.
      controller.adoptRunning();
      preArmBufferRef.current = "";
    } else {
      controller.start();
      // Replay any output that streamed before the controller existed (direct-spawn banner race),
      // so the readiness tracker sees the banner it would otherwise have missed.
      if (preArmBufferRef.current) {
        controller.observe(preArmBufferRef.current);
        preArmBufferRef.current = "";
      }
    }
    refreshPhase();
  }, [pty.status, pty.mode, pty.reattached, spec, runnerType, refreshPhase, submitToPty, runnerConfig, fallbackCommand, onPersistSession, id, agentPaneId, initialTask, persistKey]);

  // NOT gated by the hook stream, deliberately — `plans/honest-agent-status/` Slice 7 planned to
  // demote this alongside the idle timeout below, and that was wrong. This is not a status guess: it
  // calls `forceReady()` to advance the LAUNCH PHASE, which is what unblocks the dispatch gate.
  // Hook facts cannot do that job — Slice 3 made `connecting` survive them precisely BECAUSE it
  // gates routing (`canReceiveNow("connecting")` is false) — so this fallback is the only thing that
  // can move a pane out of `awaiting-ready` when banner detection fails. Demote it and dispatch
  // hangs "queued" forever for exactly the panes it was written to rescue.
  //
  // Safety net (production hardening): if readiness detection never fires — e.g. a runner CLI whose
  // TUI banner we don't recognize after an upgrade — force the persona ready once its output has
  // SETTLED (quiet for LIVE_AGENT_READY_QUIET_MS = it is sitting at the prompt), so dispatch never
  // hangs "queued" forever. Settle-based, not a fixed delay: a slow boot that keeps streaming resets
  // the wait, so we never force-ready (and auto-submit) into a still-booting/working TUI. `forceReady`
  // is a no-op unless phase is still "awaiting-ready"; if the tracker detects readiness first, phase
  // advances and this effect re-runs and tears the watcher down.
  useEffect(() => {
    if (pty.status !== "connected" || phase !== "awaiting-ready") return;
    lastOutputAtRef.current = Date.now(); // start the quiet window from when we begin watching
    let timer = 0;
    const check = () => {
      const quietFor = Date.now() - lastOutputAtRef.current;
      if (quietFor >= LIVE_AGENT_READY_QUIET_MS) {
        controllerRef.current?.forceReady();
        refreshPhase();
      } else {
        // Output arrived recently — wait out the remaining quiet window (debounce).
        timer = window.setTimeout(check, LIVE_AGENT_READY_QUIET_MS - quietFor);
      }
    };
    timer = window.setTimeout(check, LIVE_AGENT_READY_QUIET_MS);
    return () => window.clearTimeout(timer);
  }, [pty.status, phase, refreshPhase]);

  // `hookCapable` tells the done-callout channel and fleet this runner's turn ends arrive via its
  // CLI hook, so their byte-idle fallbacks can keep their hands off the pane.
  const hookCapable = isHookCapableRunner(runnerType, runnerConfig?.claude_family);

  // Idle timeout (RC-2 fix): detect agents that reached "ready"/"running" phase but then hung —
  // no output for LIVE_AGENT_IDLE_TIMEOUT_MS means the CLI is alive but unresponsive (stuck TUI,
  // deadlock, etc.). Mark the output signal as stalled so the single status publisher below can
  // project it into the fleet without creating a second, sticky registry writer.
  //
  // GATED by runner capability. For a step-reporting runner, PTY silence is not evidence of a hang:
  // the model can reason or wait on a tool without painting any bytes, while its hooks still own the
  // turn state. Step-silent runners keep this backstop because bytes are their only mid-turn signal.
  const LIVE_AGENT_IDLE_TIMEOUT_MS = 30_000;
  useEffect(() => {
    if (pty.status !== "connected") return;
    if (phase === "awaiting-ready") return; // handled by the settle-based readiness fallback above
    // Only watch agents that should be responsive (ready/running).
    if (phase !== "ready" && phase !== "running") return;
    if (turnCapability.reportsSteps) return;

    let idleTimer: number;
    const checkIdle = () => {
      const quietFor = Date.now() - lastOutputAtRef.current;
      if (
        quietFor >= LIVE_AGENT_IDLE_TIMEOUT_MS
        && !idleStalledRef.current
        // A submit is explicit evidence that this runner owns an active turn. Step-silent CLIs
        // such as OpenCode can legitimately spend longer than the byte-idle threshold reasoning or
        // running a quiet subprocess, so silence must not override that stronger lifecycle fact.
        && !paneTurnRegistry.isTurnOpen(agentPaneId)
        // Read at fire time, not at effect setup: the fact that matters is the one standing when
        // the window elapses, and a pane can go from `running` to `needs-input` inside it.
        && shouldPublishStalled({
          fact: agentTurnRegistry.get(agentPaneId),
          answeredAtMs: agentTurnRegistry.answeredAt(agentPaneId),
        })
      ) {
        idleStalledRef.current = true;
        setOutputStalled(true);
      }
      idleTimer = window.setTimeout(checkIdle, LIVE_AGENT_IDLE_TIMEOUT_MS / 4);
    };
    idleTimer = window.setTimeout(checkIdle, LIVE_AGENT_IDLE_TIMEOUT_MS);
    return () => {
      window.clearTimeout(idleTimer);
    };
  }, [pty.status, phase, agentPaneId, turnCapability.reportsSteps]);

  // Cancel a pending delayed-Enter (and any queued submits) if the node unmounts mid-submit.
  useEffect(() => () => submitQueueRef.current?.dispose(), []);

  // Publish persona status + PTY session to the fleet/inbox so peers can discover, read, and
  // dispatch to it via the MCP tools (ADR-0022 / Fase 2 cross-agent handoff).
  const publishedStatus = outputStalled && presentation.status === "running"
    ? "stalled"
    : presentation.status;

  // A graph run (Run Node) can drive this agent: the step is typed in as one turn, and the turn
  // signals above decide when it ends (plans/canvas-graph-run, ticket #80).
  useLiveAgentRunRegistration({
    id,
    name,
    submit: dispatchOrQueue,
    fact: turnFact,
    reportsTurnEnd: turnCapability.reportsTurnEnd,
    status: publishedStatus,
    ptyEnded: pty.status === "ended" || pty.status === "error",
    sessionId: pty.sessionId ?? null,
  });
  useEffect(() => {
    const projectIdOrUndefined = projectId ?? undefined;
    const identity = { nodeId: id, name, projectId: projectIdOrUndefined };
    agentStatusRegistry.publish({
      id,
      hookPaneId: agentPaneId,
      name,
      status: publishedStatus,
      sessionId: pty.sessionId,
      hookCapable,
      projectId: projectIdOrUndefined,
      aliases: buildAgentRunnerAliases({ name, runner: runnerType, runnerCommand }),
      runner: runnerType,
      runnerCommand,
      // The same string the header draws (`Atlas · acme`) — published rather than
      // re-derived downstream, where a custom runner's registry name is not known.
      runnerLabel: runnerIdentity.label,
      claudeFamily: runnerConfig?.claude_family,
    });
    statusRecoveryPendingRef.current = false;
    // Durable identity survives an unmount (project switch) so a cross-project finish can still be
    // announced and attributed to its repo — the live roster entry above is wiped on unmount. Also
    // key by PTY session id so older already-running panes with unscoped LOTUS_PANE_ID still resolve.
    agentIdentityRegistry.record(agentPaneId, identity);
    if (pty.sessionId) agentIdentityRegistry.record(`session:${pty.sessionId}`, identity);
  }, [id, agentPaneId, name, tone, publishedStatus, pty.sessionId, hookCapable, projectId, runnerType, runnerCommand, runnerIdentity.label, runnerConfig?.claude_family, statusEvidenceVersion]);
  useEffect(
    () => () => {
      // Unmount (e.g. a project switch) clears the LIVE roster + turn state, but NOT the durable
      // identity — that is forgotten only on a real close (handleClose) so a still-running agent in a
      // switched-away project keeps its "done" callout.
      agentStatusRegistry.remove(id);
      paneTurnRegistry.clear(agentPaneId);
    },
    [id, agentPaneId],
  );

  const handleClose = useCallback(() => {
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }, [dispatchCommand, onClose, id]);

  // Open/focus a Skills node wired to this live agent. Dropping a skill onto the agent then
  // dispatches `/skill-name` into its terminal (ADR-0027 Phase 6a).
  const handleAddSkills = useCallback(() => {
    dispatchCommand?.({ kind: "agent-add-skills", agentId: id, cwd: runCwd });
  }, [dispatchCommand, id, runCwd]);

  // Toggle focus mode on this agent — same command the NL bar's "fokus ke X" takes, so the
  // header button, double-click, and voice all land in useCanvasFocusMode.
  const handleFocusMode = useCallback(() => {
    dispatchCommand?.({ kind: "focus-node", nodeId: id });
  }, [dispatchCommand, id]);

  // Inline rename (NP.5): validate the desired handle against the other agents on the canvas (self
  // excluded), and on success persist it via the node-command dispatcher. The verdict flows back to
  // the header so a rejection keeps the field open with a reason. The running agent keeps its session;
  // only the canvas handle changes — teammates address it by the new name from here on.
  const handleRename = useCallback(
    (next: string): NameValidation => {
      const taken = agentStatusRegistry.list().filter((a) => a.id !== id).map((a) => a.name);
      const verdict = validateAgentName(next, taken);
      if (verdict.ok && dispatchCommand) dispatchCommand({ kind: "rename-agent", agentId: id, name: next.trim() });
      return verdict;
    },
    [dispatchCommand, id],
  );

  // Skill drop target (ADR-0027 Phase 6a): a skill dragged from the Skills node onto a live agent
  // resolves via this droppable id and is dispatched into the terminal. Mirrors the headless card.
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `${AGENT_DROP_PREFIX}${id}` });

  return (
    <CanvasNodeFrame
      kind="agent"
      selected={!!selected}
      minWidth={300}
      minHeight={220}
      lodTier={lodTier}
      dropActive={dropActive}
      dropLabel={name ? `Drop to attach to ${name}` : "Drop to attach"}
      header={
        <AgentPersonaHeader
          name={name}
          runner={runnerType}
          runnerIdentity={runnerIdentity}
          tone={tone}
          headline={headline}
          color={color}
          onFocusMode={dispatchCommand ? handleFocusMode : undefined}
          onAddSkills={dispatchCommand ? handleAddSkills : undefined}
          skillsActive={hasSkillsNode}
          onRename={dispatchCommand ? handleRename : undefined}
          conversationTitle={
            activeSession && dispatchCommand ? (
              <NodeConversationTitle
                key={activeSession.id}
                session={activeSession}
                store={canvasSessionStore}
                paneId={agentPaneId}
                provider={runnerType === "codex" ? "codex" : "claude"}
                onChanged={() => void nodeSessions.refresh()}
              />
            ) : undefined
          }
          accountChip={
            runnerType === "claude" && onSwitchAccount ? (
              <span className="canvas-persona-account nodrag nopan" onPointerDown={(e) => e.stopPropagation()}>
                <ChatAccountPicker
                  accounts={claudeAccounts}
                  current={currentAccount}
                  // Mid-turn a restart would cut the reply off, as a chat waits for its reply.
                  disabled={relaunching || presentation.status === "running"}
                  onPick={switchAccount}
                  onOpen={refreshAccounts}
                  below
                  subject={name || "This agent"}
                  confirm={(to) =>
                    dormant
                      ? null
                      : resumeSessionId
                        ? `Restart ${name || "this agent"} on ${to}? The conversation continues there.`
                        : `Restart ${name || "this agent"} on ${to}? No conversation is saved yet, so it starts fresh.`
                  }
                  footer={dormant ? "Used when this agent starts." : "Restarts the agent; the conversation continues there."}
                />
              </span>
            ) : undefined
          }
          sessionCount={nodeSessions.sessions.length}
          sessionsOpen={sessionListOpen}
          onOpenSessions={() => {
            const next = !sessionListOpen;
            setSessionListOpen(next);
            setPendingSwitch(null);
            if (next) void nodeSessions.refresh();
          }}
          onClose={handleClose}
        />
      }
    >
      <div
        ref={setDropRef}
        className={`canvas-node-body canvas-node-body--delivery-anchored nodrag nopan nowheel${isOver ? " canvas-node-body--drop-over" : ""}`}
        data-testid="live-agent-body"
        data-canvas-agent-delivery-surface={id}
        onMouseDown={(e) => {
          // ReactFlow's pan/zoom listener starts on native mousedown, not pointerdown. Claim it
          // before it can preventDefault() and leave xterm's scroll viewport without DOM focus.
          e.stopPropagation();
          xtermRef.current?.focus();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span ref={deliveryTargetRef} className="canvas-live-agent-delivery-target" data-canvas-agent-delivery-target={id} aria-hidden />
        {dormant && (
          <CanvasDormantAgentCard
            title={nodeSessions.sessions.find((sx) => sx.id === nodeSessions.activeSessionId)?.title}
            preview={dormantPreview.text}
            loadingPreview={dormantPreview.loading}
            meta={nodeSessions.sessions.length > 1 ? `${nodeSessions.sessions.length} saved sessions` : null}
            onResume={() => setDormant(false)}
          />
        )}
        {sessionListOpen && (
          <CanvasNodeSessionList
            sessions={nodeSessions.sessions}
            agentName={name}
            activeSessionId={nodeSessions.activeSessionId}
            loading={nodeSessions.loading}
            busy={relaunching}
            onTogglePinned={(session, pinned) => void nodeSessions.setPinned(session, pinned)}
            needsYou={presentation.status === "needs-you" ? { headline: headlineFor(agentPaneId) } : null}
            confirm={
              pendingSwitch
                ? {
                    sessionId: pendingSwitch.sessionId,
                    text: needsYouConfirmText(name, headlineFor(agentPaneId)),
                    onAnswer: (go) => {
                      setPendingSwitch(null);
                      if (!go) return;
                      sessionControl.commit(pendingSwitch.intent);
                      setSessionListOpen(false);
                    },
                  }
                : null
            }
            onSelect={onSwitchSession ? (session) => requestSwitch({ kind: "resume", session }, session.id) : undefined}
            onNewSession={onSwitchSession ? () => requestSwitch({ kind: "new" }, null) : undefined}
            onClose={() => {
              setPendingSwitch(null);
              setSessionListOpen(false);
            }}
          />
        )}
        <CanvasPtyViewport
          containerRef={containerRef}
          collapsed={collapsed}
          glyph={{
            label: name,
            tone: tone === "running" ? "active" : tone === "error" ? "error" : "neutral",
            detail: model,
            testId: "live-agent-glyph-cover",
          }}
        />
      </div>
    </CanvasNodeFrame>
  );
});
