import {
  createAgentRunnerReadinessTracker,
  type AgentRunnerReadinessTracker,
  type AgentRunnerType,
} from "@/lib/agent-runtime";
import type { LiveAgentSpawnSpec } from "./live-agent-spawn";

export type LiveAgentLaunchPhase = "idle" | "awaiting-ready" | "ready" | "running" | "failed";

/**
 * Whether a live agent can accept a dispatched task/message right now. True once the runner is up
 * (ready or working) — never while it is still launching or after it has failed — so the dispatch
 * (e.g. via sendAgentMessage / the team composer) isn't swallowed by a half-started REPL.
 */
export function canDispatchToLiveAgent(phase: LiveAgentLaunchPhase): boolean {
  return phase === "ready" || phase === "running";
}

/** A connected PTY may buffer during startup, but a failed runner can never become ready to flush. */
export function canQueueToLiveAgent(phase: LiveAgentLaunchPhase): boolean {
  return phase !== "failed";
}

export interface LiveAgentLaunchController {
  /** Current phase of bringing the persona online. */
  readonly phase: LiveAgentLaunchPhase;
  /** Call once the PTY shell is live: writes the runner command to launch the agent CLI. */
  start(): void;
  /** Feed each PTY output chunk: detects readiness and auto-submits the prompt exactly once. */
  observe(data: string): void;
  /**
   * Safety net: force the persona ready when the readiness tracker never fires — e.g. a runner TUI
   * whose banner we don't recognize (a CLI upgrade rewords it). Only acts while still awaiting
   * readiness; mirrors the normal ready transition (auto-submits a pending initial task exactly
   * once). A no-op once ready/running/failed, so it can never double-submit or resurrect a dead run.
   */
  forceReady(): void;
  /**
   * Adopt an already-running session (reattach after a project switch): mark the persona
   * dispatchable WITHOUT typing the launch command or re-submitting the initial task — the CLI is
   * still alive from before the switch and already ran its launch/initial turn. A no-op unless idle.
   */
  adoptRunning(): void;
}

/** Claude prints this when `--resume <id>` targets a session that no longer exists (ADR-0027 Phase 5). */
const RESUME_SESSION_MISSING = /no conversation found with session id/i;

export interface LiveAgentLaunchInput {
  spec: LiveAgentSpawnSpec;
  /** Writes raw bytes to the PTY — used for the single-line launch command (Enter included). */
  write: (text: string) => void;
  /**
   * Submits the multi-line live prompt. Kept separate from `write` because TUI runners
   * (Claude Code, Codex) use bracketed paste: a prompt + trailing Enter sent as one burst is
   * captured as a paste and never submitted. The caller pastes the text, then sends Enter on a
   * short delay so the TUI registers it as a real submit.
   */
  submit: (text: string) => void;
  runner?: AgentRunnerType;
  /** Injectable for tests; defaults to the Agent Runtime Kernel's readiness tracker. */
  tracker?: AgentRunnerReadinessTracker;
  /**
   * Bare command to relaunch with if a `--resume` launch reports the session is gone (ADR-0027
   * Phase 5 hardening). When set and the runner prints "no conversation found", the controller
   * relaunches once with this command instead of hanging in awaiting-ready forever.
   */
  fallbackCommand?: string;
  /** Called when the resume launch fails and we fall back, so the caller can clear the stale id. */
  onResumeFailed?: () => void;
  /**
   * "typed" (default): the PTY is a shell; start() types the launch command into it.
   * "direct": the CLI is already the PTY child (shell-less spawn) — start() only arms the
   * readiness watch. Resume fallback is a typed-path concern (direct launches are fresh).
   */
  launchMode?: "typed" | "direct";
}

/**
 * Orchestrates bringing a live Canvas Agent Node persona online (ADR-0022/0023):
 * launch the runner CLI in the shell, watch its output through the Agent Runtime Kernel's
 * readiness adapter, and auto-submit the live operating prompt exactly once it is ready. Pure
 * and runtime-agnostic — `write` and the readiness `tracker` are injected, so the control flow
 * is unit-testable without a real PTY.
 */
export function createLiveAgentLaunchController(input: LiveAgentLaunchInput): LiveAgentLaunchController {
  const tracker = input.tracker ?? createAgentRunnerReadinessTracker(input.runner);
  let phase: LiveAgentLaunchPhase = "idle";
  let fellBack = false;
  // Small rolling buffer so the resume-failure line is detected even if split across chunks.
  let failBuffer = "";

  // Persona is up (fresh launch only — reattach uses adoptRunning and never calls this):
  //   1. Phase 5: send the runner-agnostic peer bootstrap first, if present, so a codex/custom
  //      agent learns who it is + how to reach teammates before doing any work. Separated from the
  //      user task and sent exactly once (markReady fires once per fresh session).
  //   2. Auto-submit the initial task if there is one, else sit ready (idle).
  const markReady = () => {
    if (input.spec.bootstrapText) {
      input.submit(input.spec.bootstrapText);
    }
    if (input.spec.submitText) {
      input.submit(input.spec.submitText);
      phase = "running";
    } else {
      phase = "ready";
    }
  };

  return {
    get phase() {
      return phase;
    },
    start() {
      if (phase !== "idle") return;
      if (input.launchMode !== "direct") input.write(`${input.spec.command}\n`);
      phase = "awaiting-ready";
    },
    observe(data: string) {
      if (phase !== "awaiting-ready") return;
      // Stale-session recovery: a `--resume` launch whose session is gone prints "no conversation
      // found" and drops back to the shell (never matching a ready/failed pattern → would hang).
      // Relaunch once with the bare command and let the caller clear the dead id.
      if ((input.fallbackCommand || input.launchMode === "direct") && !fellBack) {
        failBuffer = `${failBuffer}${data}`.slice(-2000);
        if (RESUME_SESSION_MISSING.test(failBuffer)) {
          fellBack = true;
          input.onResumeFailed?.();
          // A direct spawn has no shell to type into — the CLI itself is the PTY child. Recovery is
          // the caller's respawn, and staying in `awaiting-ready` would wait for a runner that is
          // already gone (`plans/codecanvas-session-refactor/issues/08`).
          if (input.launchMode === "direct") {
            phase = "failed";
            return;
          }
          input.write(`${input.fallbackCommand}\n`);
          return;
        }
      }
      const signal = tracker.observe(data);
      if (signal.state === "ready") {
        markReady();
      } else if (signal.state === "failed") {
        phase = "failed";
      }
    },
    forceReady() {
      if (phase !== "awaiting-ready") return;
      markReady();
    },
    adoptRunning() {
      if (phase !== "idle") return;
      phase = "ready";
    },
  };
}
