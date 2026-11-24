/**
 * Bridge task store — local persistence for tasks that survive across
 * orchestrator turns and app restarts.
 *
 * Schema mirrors BridgeMCP cloud (Project/Task/Agent) so that future
 * cloud co-registration (Phase 04) can map 1:1.
 */

export type BridgeTaskStatus =
  | "todo"
  | "in-progress"
  | "blocked"
  | "in-review"
  | "complete"
  | "cancelled";

export type BridgePriority = "none" | "low" | "medium" | "high";

export type BridgeTask = {
  id: string;
  workspaceId: string;
  /**
   * The task's number within its workspace — the half of `INT-2` that names the task.
   *
   * Absent on tasks written before the store numbered them. Assigned once, at creation, from a
   * counter that survives deletion (`bridge_tasks.rs`), so a key never names two tasks.
   */
  number?: number;
  teamId?: string;
  title: string;
  goal: string;
  knowledge: string;
  status: BridgeTaskStatus;
  priority: BridgePriority;
  assignees: readonly string[];
  createdAt: number;
  updatedAt: number;
  /** PTY pane id for the cell currently executing this task. */
  cellId?: string;
  /** Last execution error surfaced to the UI. */
  lastError?: string;
  /*
    Everything below was already being WRITTEN by the MCP tools and stored by `bridge_tasks.rs`,
    and was simply never declared here — so no surface in the desktop app could read a single
    field of it. Declared now, in the order the Rust struct has them, because that struct is the
    contract and a type that drifts from it is a lie the compiler will believe.
  */
  subtasks?: readonly BridgeSubTask[];
  dueDate?: number;
  intake?: BridgeTaskIntake;
  blocker?: BridgeTaskBlocker;
  feedbackEvents?: readonly BridgeTaskFeedbackEvent[];
  /** Where this task came from, when it did not start here. */
  source?: TaskSource;
  /** Its place in the manual order; absent until first moved (`bridge_tasks.rs`). */
  position?: number;
};

/**
 * A one-way link back to whatever this task was made from.
 *
 * One-way on purpose: a task delegated from an Obsidian ticket points at the ticket's FILE, and
 * the vault learns nothing. It stays the human's record and Notion stays the team's, so nothing
 * Lotus does can make either of them wrong.
 */
export type TaskSource = {
  /**
   * Where the task came from. `vault` is an Obsidian ticket — the word predates ticket sources and
   * stays, because tasks already on disk carry it. `notion` is a Notion page; `github` is a GitHub
   * issue (`owner/name#123`, ADR-0048). The Rust side stores this as a plain string
   * (`bridge_tasks.rs`), so a new kind needs no migration.
   */
  kind: "vault" | "notion" | "github";
  /** The file, not the key: two files in a real vault both carry `ticket: DRAFT`. */
  ref: string;
  label: string;
};

/**
 * The three words the store can actually produce.
 *
 * `bridge_tasks.rs` serialises `SubTaskStatus` as `pending | in-progress | completed`, and it has
 * no fallback variant — so `"done"` and `"blocked"`, which this type used to claim, were not just
 * unread, they were values the Rust deserialiser would REJECT if an agent ever sent one.
 */
export type SubTaskStatus = "pending" | "in-progress" | "completed";

export type BridgeSubTask = {
  id: string;
  title: string;
  status: SubTaskStatus;
  assignedTo?: string;
};

/** What the director decided when it first read the task. */
export type BridgeTaskIntakeDecision = "assign" | "ask-human" | "blocked";

export type BridgeTaskIntake = {
  briefXml: string;
  confidence: number;
  decision: BridgeTaskIntakeDecision;
  updatedAt: number;
};

export type BridgeTaskBlockerPhase = "intake" | "assignment" | "execution" | "review";

export type BridgeTaskBlockerType =
  | "human-input"
  | "ambiguity"
  | "auth"
  | "dependency"
  | "verification-failed"
  | "system-error";

export type BridgeTaskBlocker = {
  phase: BridgeTaskBlockerPhase;
  type: BridgeTaskBlockerType;
  reason: string;
  questionId?: string;
};

export type BridgeTaskFeedbackActor = "director" | "human" | "agent" | "reviewer" | "system";

export type BridgeTaskFeedbackKind =
  | "intake-created"
  | "hitl-question"
  | "hitl-answer"
  | "assignment-plan-created"
  | "assignment-dispatched"
  | "agent-result"
  | "review-requested"
  | "review-verdict"
  | "revision-requested"
  | "task-blocked"
  | "task-status-changed";

/** One line of what happened to this task, written by whoever did it. */
export type BridgeTaskFeedbackEvent = {
  id: string;
  at: number;
  actor: BridgeTaskFeedbackActor;
  kind: BridgeTaskFeedbackKind;
  summary: string;
  payload?: unknown;
};

export type CreateTaskInput = {
  workspaceId: string;
  teamId?: string;
  title: string;
  goal: string;
  knowledge?: string;
  assignees?: readonly string[];
  status?: BridgeTaskStatus;
  priority?: BridgePriority;
  source?: TaskSource;
};

export type TaskListFilter = {
  workspaceId?: string;
  status?: BridgeTaskStatus;
  assignee?: string;
};

export type UpdateTaskPatch = Partial<{
  title: string;
  goal: string;
  knowledge: string;
  status: BridgeTaskStatus;
  assignees: readonly string[];
  teamId: string;
  priority: BridgePriority;
  /** Pass `null` to explicitly clear the binding. */
  cellId: string | null;
  /** Pass `null` to explicitly clear the last error. */
  lastError: string | null;
  /** A new place in the manual order. Set only — the store never clears it. */
  position: number;
}>;

export class TaskNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<BridgeTask>;
  get(id: string): Promise<BridgeTask | undefined>;
  list(filter?: TaskListFilter): Promise<readonly BridgeTask[]>;
  update(id: string, patch: UpdateTaskPatch): Promise<BridgeTask>;
}

export function applyTaskPatch(
  task: BridgeTask,
  patch: UpdateTaskPatch,
  updatedAt: number,
): BridgeTask {
  const next: BridgeTask = { ...task, updatedAt };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.goal !== undefined) next.goal = patch.goal;
  if (patch.knowledge !== undefined) next.knowledge = patch.knowledge;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.assignees !== undefined) next.assignees = patch.assignees;
  if (patch.teamId !== undefined) next.teamId = patch.teamId;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.cellId !== undefined) {
    if (patch.cellId === null) delete next.cellId;
    else next.cellId = patch.cellId;
  }
  if (patch.lastError !== undefined) {
    if (patch.lastError === null) delete next.lastError;
    else next.lastError = patch.lastError;
  }
  return next;
}

/**
 * Field caps mirror BridgeMCP cloud schema (title 120, instructions 5K
 * → repurposed as "goal" 500, taskKnowledge 50K). Future cloud
 * co-registration in Phase 04 maps 1:1 against these.
 */
export const TASK_CAPS = Object.freeze({
  TITLE: 120,
  GOAL: 500,
  KNOWLEDGE: 200_000,
});

function validateInput(input: CreateTaskInput | UpdateTaskPatch, mode: "create" | "update"): void {
  if (mode === "create") {
    const c = input as CreateTaskInput;
    if (!c.workspaceId || c.workspaceId.length === 0) throw new Error("workspaceId is required");
    if (!c.title || c.title.length === 0) throw new Error("title is required");
    if (!c.goal || c.goal.length === 0) throw new Error("goal is required");
  }
  if (input.title !== undefined && input.title.length > TASK_CAPS.TITLE) {
    throw new Error(`title exceeds cap (${TASK_CAPS.TITLE})`);
  }
  if (input.goal !== undefined && input.goal.length > TASK_CAPS.GOAL) {
    throw new Error(`goal exceeds cap (${TASK_CAPS.GOAL})`);
  }
  if (input.knowledge !== undefined && input.knowledge.length > TASK_CAPS.KNOWLEDGE) {
    throw new Error(`knowledge exceeds cap (${TASK_CAPS.KNOWLEDGE})`);
  }
}

const ID_PREFIX = "task_";

function makeId(now: () => number): string {
  // Random 10-char base36, prefixed. Sufficient uniqueness for local store.
  const random = Math.random().toString(36).slice(2, 8);
  const stamp = now().toString(36).slice(-4);
  return `${ID_PREFIX}${stamp}${random}`;
}

export type InMemoryTaskStoreOptions = {
  /** Override clock for deterministic tests. */
  now?: () => number;
  /** Pre-seed with persisted tasks (preserves ids and timestamps). */
  initialTasks?: readonly BridgeTask[];
};

/**
 * Storage adapter abstracts the actual persistence backend.
 * Production: Tauri filesystem (Phase 03 take 2).
 * Tests: in-memory string holder.
 */
export interface StorageAdapter {
  load(): Promise<string | null>;
  save(payload: string): Promise<void>;
}

type SerializedShape = {
  v: 1;
  tasks: BridgeTask[];
};

function serializeAll(tasks: Iterable<BridgeTask>): string {
  const payload: SerializedShape = { v: 1, tasks: Array.from(tasks) };
  return JSON.stringify(payload);
}

function deserializeAll(raw: string | null): BridgeTask[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SerializedShape;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) return [];
    return parsed.tasks;
  } catch {
    return [];
  }
}

/**
 * Persistent task store backed by an injectable storage adapter.
 * Loads existing tasks on construction; writes through on every mutation.
 * Concurrency: single-writer per adapter — adapter handles serialization.
 */
export async function createPersistentTaskStore(
  adapter: StorageAdapter,
  opts: InMemoryTaskStoreOptions = {},
): Promise<TaskStore> {
  const initial = deserializeAll(await adapter.load());
  const inner = createInMemoryTaskStore({ ...opts, initialTasks: initial });

  const persist = async () => {
    const all = await inner.list();
    await adapter.save(serializeAll(all));
  };

  return {
    async create(input) {
      const t = await inner.create(input);
      await persist();
      return t;
    },
    async get(id) {
      return inner.get(id);
    },
    async list(filter) {
      return inner.list(filter);
    },
    async update(id, patch) {
      const t = await inner.update(id, patch);
      await persist();
      return t;
    },
  };
}

export function createInMemoryTaskStore(
  opts: InMemoryTaskStoreOptions = {},
): TaskStore {
  const now = opts.now ?? Date.now;
  const tasks = new Map<string, BridgeTask>();
  if (opts.initialTasks) {
    for (const t of opts.initialTasks) tasks.set(t.id, t);
  }

  return {
    async create(input) {
      validateInput(input, "create");
      const ts = now();
      const task: BridgeTask = {
        id: makeId(now),
        workspaceId: input.workspaceId,
        ...(input.teamId !== undefined && { teamId: input.teamId }),
        title: input.title,
        goal: input.goal,
        knowledge: input.knowledge ?? "",
        status: input.status ?? "todo",
        priority: input.priority ?? "none",
        assignees: input.assignees ?? [],
        createdAt: ts,
        updatedAt: ts,
      };
      tasks.set(task.id, task);
      return task;
    },
    async get(id) {
      return tasks.get(id);
    },
    async list(filter) {
      const all = Array.from(tasks.values());
      if (!filter) return all;
      return all.filter((t) => {
        if (filter.workspaceId && t.workspaceId !== filter.workspaceId) return false;
        if (filter.status && t.status !== filter.status) return false;
        if (filter.assignee && !t.assignees.includes(filter.assignee)) return false;
        return true;
      });
    },
    async update(id, patch) {
      validateInput(patch, "update");
      const existing = tasks.get(id);
      if (!existing) throw new TaskNotFoundError(id);
      const next = applyTaskPatch(existing, patch, now());
      tasks.set(id, next);
      return next;
    },
  };
}
