import type { CanvasSessionRecord } from "./session-record";
import type { RelaunchIntent, RelaunchVerdict } from "./session-relaunch";

/**
 * Per-node session control, so surfaces outside a node can act on its conversations
 * (`plans/codecanvas-session-widget/`, Slice 04).
 *
 * The relaunch machinery has to live inside `LiveAgentNode` — it manipulates that node's PTY hold,
 * its pooled process, and its launch guards, none of which exist anywhere else. But the corner
 * popover, the ⌘K rows, and the cycle hotkeys all need to reach it. A node registers a handle here;
 * everything else looks it up by node id.
 *
 * Mirrors `agent-reply-registry.ts`, which solved the same problem for the team composer.
 */
export interface AgentSessionControlHandle {
  /** This node's conversations, newest activity first. */
  sessions: () => CanvasSessionRecord[];
  /** The one the node is in right now, or null. */
  activeSessionId: () => string | null;
  /** True while the node is asleep — no process, waiting to be asked. */
  isDormant: () => boolean;
  /**
   * Wake a sleeping node, launching it against the pointer it already carries. No-op when awake.
   *
   * The `adopt` path needs exactly this and nothing more: a node made for a session already knows
   * which conversation it is for, so relaunching it would ask the board for a pointer it has and
   * wait forever for a change that never comes.
   */
  wake: () => void;
  /**
   * Decide, without touching anything. Split out from {@link commit} because the old single-step
   * `resume()` executed before its verdict could be read, which made `confirm: "needs-you"`
   * impossible to honour (`plans/codecanvas-session-refactor/issues/02`).
   */
  judge: (intent: RelaunchIntent) => RelaunchVerdict;
  /** Do it: wake the node if it sleeps, then relaunch its runner against `intent`. */
  commit: (intent: RelaunchIntent) => void;
  /**
   * Judge, then commit only if nothing has to be asked first. A verdict carrying `confirm` comes
   * back with the runtime untouched — the caller asks the human and calls {@link commit} on a yes.
   */
  request: (intent: RelaunchIntent) => RelaunchVerdict;
  /**
   * Continue a conversation on this node: wake it if it is asleep, and relaunch its runner against
   * that session if it is running a different one.
   *
   * Returns the verdict so the caller can explain a refusal rather than appear to do nothing.
   */
  resume: (session: CanvasSessionRecord) => RelaunchVerdict;
  /** Start a fresh conversation, keeping the node's identity. */
  startNew: () => RelaunchVerdict;
}

export interface AgentSessionControlRegistry {
  register(nodeId: string, handle: AgentSessionControlHandle): () => void;
  get(nodeId: string): AgentSessionControlHandle | undefined;
  /**
   * Resolve once a node has published its controls, or `null` once `timeoutMs` has passed.
   *
   * This is what turns "make a node for this session, then run it" into one gesture: the caller
   * creates the node and awaits its handle instead of guessing at a delay. The timeout is not
   * optional — a node that fails to mount has to become a sentence, never a promise that hangs.
   */
  waitFor(nodeId: string, timeoutMs: number): Promise<AgentSessionControlHandle | null>;
}

export function createAgentSessionControlRegistry(): AgentSessionControlRegistry {
  const handles = new Map<string, AgentSessionControlHandle>();
  const waiters = new Map<string, Set<(handle: AgentSessionControlHandle) => void>>();
  return {
    register(nodeId, handle) {
      handles.set(nodeId, handle);
      const pending = waiters.get(nodeId);
      if (pending) {
        waiters.delete(nodeId);
        for (const resolve of pending) resolve(handle);
      }
      return () => {
        // Only clear our own entry: a remount registers the new handle before the old one's cleanup
        // runs, and deleting unconditionally would leave the node unreachable.
        if (handles.get(nodeId) === handle) handles.delete(nodeId);
      };
    },
    get(nodeId) {
      return handles.get(nodeId);
    },
    waitFor(nodeId, timeoutMs) {
      const existing = handles.get(nodeId);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const settle = (handle: AgentSessionControlHandle | null) => {
          waiters.get(nodeId)?.delete(onRegistered);
          clearTimeout(timer);
          resolve(handle);
        };
        const onRegistered = (handle: AgentSessionControlHandle) => settle(handle);
        const timer = setTimeout(() => settle(null), timeoutMs);
        const pending = waiters.get(nodeId) ?? new Set();
        pending.add(onRegistered);
        waiters.set(nodeId, pending);
      });
    },
  };
}

/** Process-wide registry shared by agent nodes and every surface that lists sessions. */
export const agentSessionControlRegistry: AgentSessionControlRegistry =
  createAgentSessionControlRegistry();
