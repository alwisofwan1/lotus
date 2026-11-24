/**
 * Terminal Activity signal — `running` when the cell is doing anything,
 * `idle` when truly at rest. Three inputs produce `running`:
 *   1. A submitted line (Enter) — keystrokes alone never count
 *   2. Shell command executing (OSC 133 command-begin → command-end)
 *   3. Interactive agent actively generating output
 * See docs/adr/0004 and CONTEXT.md "Terminal Activity".
 */
import type { Osc133Event } from "./terminal-osc133";
import {
  cleanTerminalLine,
  hasActiveWorkingStatusTail,
  hasAgentReadyOutput,
  isAgentReadyLine,
  isPromptLike,
} from "./terminal-status-lines";

export type TerminalActivity = "idle" | "running";

export type TerminalActivityClock = {
  now(): number;
  setTimeout(handler: () => void, ms: number): () => void;
};

const realClock: TerminalActivityClock = {
  now: () => Date.now(),
  setTimeout(handler, ms) {
    if (typeof globalThis.setTimeout !== "function") return () => {};
    const handle = globalThis.setTimeout(handler, ms);
    return () => globalThis.clearTimeout(handle);
  },
};

/** How long after the last working-status line we keep an agent marked running. */
const DEFAULT_WORKING_QUIET_MS = 1_200;
/** How long after the last user keystroke we drop back to idle (no Enter pressed). */
const DEFAULT_USER_INPUT_QUIET_MS = 800;
/** Safety cap for submitted shell commands when no OSC/prompt signal exists. */
const DEFAULT_SUBMITTED_COMMAND_QUIET_MS = 30_000;

export type TerminalUserInputActivityHint = {
  data?: string;
  submitted?: boolean;
  agentTurnCandidate?: boolean;
};

type PaneState = {
  commandActive: boolean;
  agentSeenThisCommand: boolean;
  agentWorking: boolean;
  userInputActive: boolean;
  submittedCommandActive: boolean;
  /**
   * Latched true when the xterm rendered buffer (or stream fast-path) confirms
   * the agent is at its standby prompt (Claude/Codex ready footer). Blocks Tier 3
   * from flipping the badge back to running on status-bar repaints. Cleared when a Working(…)
   * status line is seen (agent started thinking again).
   */
  agentExplicitlyIdle: boolean;
  cancelQuiet: (() => void) | null;
  cancelUserInput: (() => void) | null;
  cancelSubmittedCommand: (() => void) | null;
  current: TerminalActivity;
  /** When `current` was last ENTERED; undefined until the first change. */
  since: number | undefined;
};

function freshState(): PaneState {
  return {
    commandActive: false,
    agentSeenThisCommand: false,
    agentWorking: false,
    userInputActive: false,
    submittedCommandActive: false,
    agentExplicitlyIdle: false,
    cancelQuiet: null,
    cancelUserInput: null,
    cancelSubmittedCommand: null,
    current: "idle",
    since: undefined,
  };
}

function derive(s: PaneState): TerminalActivity {
  if (s.agentWorking) return "running";
  if (s.commandActive && !s.agentSeenThisCommand) return "running";
  if (s.submittedCommandActive) return "running";
  // Typing alone is not work: `userInputActive` only widens the agent's turn window
  // (noteAgentStandby). Only Enter, a command, or agent output can mean `running`.
  return "idle";
}

function hasMeaningfulAgentResponseBeforeReady(raw: string): boolean {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => line.split("\r"))
    .map(cleanTerminalLine)
    .filter(Boolean);
  const readyIndex = lines.findIndex(isAgentReadyLine);
  const candidateLines = readyIndex >= 0 ? lines.slice(0, readyIndex) : lines;

  return candidateLines.some((line) => (
    !isAgentReadyLine(line)
    && !isPromptLike(line)
    && !isTerminalChromeLine(line)
  ));
}

function isTerminalChromeLine(line: string): boolean {
  const lowered = line.toLowerCase();
  return lowered.startsWith("pi v")
    || lowered.startsWith("sonnet ")
    || lowered.startsWith("openai codex")
    || lowered.includes("escape interrupt")
    || lowered.includes("loaded resources")
    || lowered.includes("update available")
    || lowered.includes("changelog:")
    || lowered === "[context]"
    || lowered === "[skills]"
    || lowered === "[prompts]";
}

export type TerminalActivityRegistry = {
  noteCommandBoundary(paneId: string, event: Osc133Event): void;
  noteOutputChunk(paneId: string, visibleData: string): void;
  /** Call whenever the user sends input to the PTY (keystrokes). */
  noteUserInput(paneId: string, hint?: TerminalUserInputActivityHint): void;
  /**
   * Call when the xterm rendered buffer (authoritative) or stream fast-path
   * confirms the agent is at its standby prompt. Latches agentExplicitlyIdle
   * so Tier 3 cannot flip the badge back to running on repaint chunks.
   */
  noteAgentStandby(paneId: string): void;
  get(paneId: string): TerminalActivity;
  /** When the pane entered its current activity; undefined if it never changed. */
  since(paneId: string): number | undefined;
  subscribe(paneId: string, cb: (activity: TerminalActivity) => void): () => void;
  reset(paneId: string): void;
};

export function createTerminalActivityRegistry(
  options: { clock?: TerminalActivityClock; workingQuietMs?: number; userInputQuietMs?: number; submittedCommandQuietMs?: number } = {},
): TerminalActivityRegistry {
  const clock = options.clock ?? realClock;
  const workingQuietMs = options.workingQuietMs ?? DEFAULT_WORKING_QUIET_MS;
  const userInputQuietMs = options.userInputQuietMs ?? DEFAULT_USER_INPUT_QUIET_MS;
  const submittedCommandQuietMs = options.submittedCommandQuietMs ?? DEFAULT_SUBMITTED_COMMAND_QUIET_MS;
  const states = new Map<string, PaneState>();
  const subscribers = new Map<string, Set<(activity: TerminalActivity) => void>>();

  const stateFor = (paneId: string): PaneState => {
    let s = states.get(paneId);
    if (!s) {
      s = freshState();
      states.set(paneId, s);
    }
    return s;
  };

  const publish = (paneId: string, s: PaneState) => {
    const next = derive(s);
    if (next === s.current) return;
    s.current = next;
    s.since = clock.now();
    subscribers.get(paneId)?.forEach((cb) => cb(next));
  };

  const clearQuiet = (s: PaneState) => {
    s.cancelQuiet?.();
    s.cancelQuiet = null;
  };

  const clearUserInput = (s: PaneState) => {
    s.cancelUserInput?.();
    s.cancelUserInput = null;
    s.userInputActive = false;
  };

  const clearSubmittedCommand = (s: PaneState) => {
    s.cancelSubmittedCommand?.();
    s.cancelSubmittedCommand = null;
    s.submittedCommandActive = false;
  };

  const isSubmittedCommandHint = (hint?: TerminalUserInputActivityHint): boolean => {
    if (hint?.submitted) return true;
    return /[\r\n]/.test(hint?.data ?? "");
  };

  return {
    noteCommandBoundary(paneId, event) {
      const s = stateFor(paneId);
      if (event.kind === "command-begin") {
        s.commandActive = true;
        s.agentSeenThisCommand = false;
        s.agentWorking = false;
        s.agentExplicitlyIdle = false;
        clearQuiet(s);
        clearSubmittedCommand(s);
      } else if (event.kind === "command-end" || event.kind === "prompt-start") {
        s.commandActive = false;
        s.agentSeenThisCommand = false;
        s.agentWorking = false;
        s.agentExplicitlyIdle = false;
        clearQuiet(s);
        clearUserInput(s);
        clearSubmittedCommand(s);
      }
      publish(paneId, s);
    },

    noteUserInput(paneId, hint) {
      const s = stateFor(paneId);
      s.userInputActive = true;
      const agentTurnCandidate = hint?.agentTurnCandidate ?? true;
      // A SUBMIT at an agent prompt starts a possible new turn. Clear the
      // standby latch so plain response text (even without a Working(...) line)
      // can flip the badge back to running via Tier 3. A bare keystroke must not:
      // its echo would then pass Tier 3 and the pane would read "working" while typing.
      if (agentTurnCandidate && isSubmittedCommandHint(hint)) {
        s.agentSeenThisCommand = true;
        s.agentExplicitlyIdle = false;
      }
      if (isSubmittedCommandHint(hint) && !agentTurnCandidate) {
        s.submittedCommandActive = true;
        s.cancelSubmittedCommand?.();
        s.cancelSubmittedCommand = clock.setTimeout(() => {
          s.cancelSubmittedCommand = null;
          s.submittedCommandActive = false;
          publish(paneId, s);
        }, submittedCommandQuietMs);
      }
      s.cancelUserInput?.();
      s.cancelUserInput = clock.setTimeout(() => {
        s.cancelUserInput = null;
        s.userInputActive = false;
        publish(paneId, s);
      }, userInputQuietMs);
      publish(paneId, s);
    },

    noteAgentStandby(paneId) {
      const s = stateFor(paneId);
      if (s.agentExplicitlyIdle) {
        s.agentSeenThisCommand = true;
        // The xterm buffer scanner observes the same idle footer every tick.
        // Once the standby latch is set, repeated observations must not extend
        // the quiet timer or a finished agent stays "running" forever.
        return;
      }
      const activeTurn = s.userInputActive || s.agentWorking || (s.agentSeenThisCommand && !s.agentExplicitlyIdle);
      s.agentSeenThisCommand = true;
      s.agentExplicitlyIdle = true;
      clearQuiet(s);
      clearSubmittedCommand(s);

      if (activeTurn) {
        // Full-screen TUIs often keep the idle footer visible while repainting a
        // response. Do not snap to idle the instant the footer is observed;
        // require a short quiet window so actively streaming agents stay marked
        // running, then settle to idle with the latch set to block future repaints.
        s.agentWorking = true;
        s.cancelQuiet = clock.setTimeout(() => {
          s.cancelQuiet = null;
          s.agentWorking = false;
          publish(paneId, s);
        }, workingQuietMs);
        publish(paneId, s);
        return;
      }

      s.agentWorking = false;
      publish(paneId, s);
    },

    noteOutputChunk(paneId, visibleData) {
      const s = stateFor(paneId);

      // Tier 2 FIRST — an explicit working line outranks the ready footer.
      //
      // The ready check used to run before this one, and that is the whole "stuck at ready" bug:
      // Claude Code keeps its mode footer on screen for the entire turn, so every repaint
      // carried a ready signal, latched `agentExplicitlyIdle`, and locked Tier 3 out for the
      // rest of the response. A visible working line is the stronger statement of the two —
      // the footer only says the pane CAN take input, never that it is finished.
      if (hasActiveWorkingStatusTail(visibleData)) {
        s.agentSeenThisCommand = true;
        s.agentExplicitlyIdle = false;
        s.agentWorking = true;
        clearQuiet(s);
        s.cancelQuiet = clock.setTimeout(() => {
          s.cancelQuiet = null;
          s.agentWorking = false;
          publish(paneId, s);
        }, workingQuietMs);
        publish(paneId, s);
        return;
      }

      // Tier 1 (stream fast-path) — standby signal in the raw tail.
      // Unreliable for TUI repaints (cursor movement codes collapse lines), so
      // the xterm buffer check in the legacy/native terminal runtime is the authoritative source.
      // Keep as a fast-path for cases where it DOES appear at the stream tail.
      if (hasAgentReadyOutput(visibleData)) {
        if (hasMeaningfulAgentResponseBeforeReady(visibleData) && s.agentSeenThisCommand) {
          s.agentSeenThisCommand = true;
          s.agentExplicitlyIdle = true;
          s.agentWorking = true;
          clearQuiet(s);
          s.cancelQuiet = clock.setTimeout(() => {
            s.cancelQuiet = null;
            s.agentWorking = false;
            publish(paneId, s);
          }, workingQuietMs);
          publish(paneId, s);
          return;
        }
        this.noteAgentStandby(paneId);
        return;
      }

      // Tier 3 — Any output while agent is known and either not explicitly idle
      // OR still inside the quiet window opened by a standby observation. The
      // second case covers TUI agents whose stale footer remains visible while
      // the next response is already streaming. Once the quiet window expires,
      // agentWorking=false and the standby latch again blocks repaint noise.
      if (s.agentSeenThisCommand && (!s.agentExplicitlyIdle || s.agentWorking)) {
        s.agentWorking = true;
        clearQuiet(s);
        s.cancelQuiet = clock.setTimeout(() => {
          s.cancelQuiet = null;
          s.agentWorking = false;
          publish(paneId, s);
        }, workingQuietMs);
        publish(paneId, s);
      }
    },

    get(paneId) {
      return states.get(paneId)?.current ?? "idle";
    },

    since(paneId) {
      return states.get(paneId)?.since;
    },

    subscribe(paneId, cb) {
      let set = subscribers.get(paneId);
      if (!set) {
        set = new Set();
        subscribers.set(paneId, set);
      }
      set.add(cb);
      cb(this.get(paneId));
      return () => {
        const s = subscribers.get(paneId);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) subscribers.delete(paneId);
      };
    },

    reset(paneId) {
      const s = states.get(paneId);
      if (s) { clearQuiet(s); clearUserInput(s); clearSubmittedCommand(s); s.agentExplicitlyIdle = false; }
      states.delete(paneId);
      const next: TerminalActivity = "idle";
      subscribers.get(paneId)?.forEach((cb) => cb(next));
    },
  };
}

/** Default shared instance — the registry is a cross-component signal bus. */
const defaultRegistry = createTerminalActivityRegistry();

export const noteTerminalCommandBoundary = defaultRegistry.noteCommandBoundary.bind(defaultRegistry);
export const noteTerminalOutputChunk = defaultRegistry.noteOutputChunk.bind(defaultRegistry);
export const noteTerminalUserInput = defaultRegistry.noteUserInput.bind(defaultRegistry);
export const noteTerminalAgentStandby = defaultRegistry.noteAgentStandby.bind(defaultRegistry);
export const getTerminalActivity = defaultRegistry.get.bind(defaultRegistry);
export const getTerminalActivitySince = defaultRegistry.since.bind(defaultRegistry);
export const subscribeTerminalActivity = defaultRegistry.subscribe.bind(defaultRegistry);
export const resetTerminalActivity = defaultRegistry.reset.bind(defaultRegistry);
