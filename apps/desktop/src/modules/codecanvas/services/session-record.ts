/**
 * An agent session as a first-class record (`plans/codecanvas-session-widget/`, Slice 01).
 *
 * A node is the worker — its name, runner, model, skills, worktree, and per-node memory. A session
 * is one conversation that worker had. Until this record existed the two were the same thing: the
 * session lived as a lone `resumeSessionId` string inside the node's data, so deleting the node
 * dropped the conversation's only trace and nothing could be listed, titled, or counted.
 *
 * The Rust row is the source of truth (`src-tauri/src/codecanvas_sessions.rs`); this is its mirror.
 */

/** Whether the conversation can be continued, and whether it is running right now. */
export type CanvasSessionStatus =
  /**
   * A CLI is alive for this session. **A cache about a process, never a durable fact** — a
   * force-quit leaves the row saying `live` with nothing behind it, so it is reconciled against the
   * live PTY list whenever a canvas loads (Slice 08).
   */
  | "live"
  /** No process, but the runner can continue the conversation from its own transcript. */
  | "resumable"
  /** No process, and this runner has no resume mechanism wired up — a restart loses the thread. */
  | "no-resume"
  /** The CLI no longer knows this session; resuming it has been tried and failed. */
  | "dead";

/** Who started the conversation. Manual sessions are the ones a person will come back to. */
export type CanvasSessionOrigin = "manual" | "graph-run" | "mcp";

export interface CanvasSessionRecord {
  /** Lotus's own id. Deliberately not the CLI's — that one may not exist yet. */
  id: string;
  projectId: string;
  /** The node hosting this session; null once that node is deleted, and the session lives on. */
  nodeId?: string | null;
  runner: string;
  /**
   * The launch command, for a runner whose type cannot name it.
   *
   * `runner` is the TYPE, and every user-defined runner — grok, opencode, a second-account Claude —
   * arrives as the single word `custom`. Rebuilding a node from this row therefore has nothing to
   * launch unless the command travels with it
   * (`plans/codecanvas-session-refactor/issues/03`, found live 2026-09-12).
   */
  runnerCommand?: string | null;
  /** The id the CLI uses for this conversation. Absent until capture succeeds. */
  providerSessionId?: string | null;
  cwd: string;
  worktreePath?: string | null;
  title: string;
  /** `prompt`: the first ask, until a model refines it. `auto`: a model's. `manual`: a person's. */
  titleSource?: "prompt" | "auto" | "manual" | null;
  status: CanvasSessionStatus;
  origin: CanvasSessionOrigin;
  graphRunId?: string | null;
  pinned?: boolean;
  turnCount?: number;
  /**
   * The last thing asked of this conversation, verbatim (trimmed).
   *
   * A list of rows all reading "Bima · sesi baru" tells nobody which conversation was which. The ask
   * is what a person actually remembers a thread by, so it is kept on the row and shown under the
   * title — the same move ChatGPT makes with its sidebar. It is captured from the PTY write stream
   * (`services/pane-ask-buffer.ts`), which is the one choke point every input path goes through, so
   * it works for runners with no hooks at all.
   */
  lastPrompt?: string | null;
  /** Claude only: the account the node ran as (portable-accounts issues/07). Absent = the chosen one. */
  account?: string | null;
  lastActivityAt: number;
  createdAt: number;
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

/** What the canvas knows about a node at the moment its session is first recorded. */
export interface SessionSeed {
  projectId: string;
  nodeId: string;
  runner?: string;
  /** Required in practice for `custom`: its type cannot name the command that launched it. */
  runnerCommand?: string | null;
  account?: string | null;
  cwd: string;
  worktreePath?: string | null;
  /** The agent's display handle, used to title the session until a real ask arrives. */
  agentName?: string;
  origin?: CanvasSessionOrigin;
  graphRunId?: string | null;
  providerSessionId?: string | null;
  status?: CanvasSessionStatus;
  now?: number;
}

/**
 * Build the row for a session that has just been captured.
 *
 * The title is deliberately taken from what the canvas already knows, never scraped from the pane's
 * output. Launch traffic goes through the same choke point a human's ask does — the persona is
 * *typed into* the pane for runners without `--append-system-prompt` — which is exactly how the
 * canvas preamble once ended up as a Codex pane's headline. `LiveAgentNode` guards that with
 * `paneAskBuffer.suspend()` and records the ask from the spec; this follows the same rule.
 */
export function buildSessionRecord(seed: SessionSeed): CanvasSessionRecord {
  const now = seed.now ?? Date.now();
  const name = seed.agentName?.trim();
  return {
    id: newId(),
    projectId: seed.projectId,
    nodeId: seed.nodeId,
    runner: seed.runner ?? "claude",
    runnerCommand: seed.runnerCommand ?? null,
    account: seed.account ?? null,
    providerSessionId: seed.providerSessionId ?? null,
    cwd: seed.cwd,
    worktreePath: seed.worktreePath ?? null,
    title: name ? `${name} · new conversation` : "New conversation",
    titleSource: "auto",
    status: seed.status ?? "live",
    origin: seed.origin ?? "manual",
    graphRunId: seed.graphRunId ?? null,
    pinned: false,
    turnCount: 0,
    lastPrompt: null,
    lastActivityAt: now,
    createdAt: now,
  };
}
