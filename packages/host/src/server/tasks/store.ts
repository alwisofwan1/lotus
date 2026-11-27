import { mkdirSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { atomicWriteJSON } from "../../core/atomic-write.js";
import { KeyedMutex } from "./keyed-mutex.js";
import type {
  CreateTaskInput, SwarmTask, TaskFeedbackEvent, TaskListFilter, UpdateTaskPatch,
} from "./types.js";

export interface SwarmTaskStoreDeps {
  /** Directory holding one `<taskId>.json` per task. Created if missing. */
  baseDir: string;
  /** Injectable clock (ms epoch) — defaults to Date.now for testability. */
  now?: () => number;
  /** Injectable id factory — defaults to a `task_<uuid>` generator. */
  newId?: () => string;
  /** Shared per-task lock so load→mutate→save never races. */
  mutex?: KeyedMutex;
}

/** Serialize mutations per task and write atomically so readers see complete task records (ADR-0019). */
export class SwarmTaskStore {
  private readonly baseDir: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly mutex: KeyedMutex;

  constructor(deps: SwarmTaskStoreDeps) {
    this.baseDir = deps.baseDir;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `task_${randomUUID()}`);
    this.mutex = deps.mutex ?? new KeyedMutex();
    mkdirSync(this.baseDir, { recursive: true });
  }

  create(input: CreateTaskInput): Promise<SwarmTask> {
    const id = this.newId();
    const at = this.now();
    const task: SwarmTask = {
      id,
      workspaceId: input.workspaceId,
      ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
      title: input.title,
      goal: input.goal,
      knowledge: input.knowledge ?? "",
      status: input.status ?? "todo",
      priority: input.priority ?? "none",
      assignees: input.assignees ?? [],
      createdAt: at,
      updatedAt: at,
      subtasks: input.subtasks ?? [],
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      feedbackEvents: [],
    };
    return this.mutex.run(id, async () => {
      await this.write(task);
      return task;
    });
  }

  get(id: string): Promise<SwarmTask | null> {
    return this.read(id);
  }

  async list(filter: TaskListFilter = {}): Promise<SwarmTask[]> {
    const tasks = await Promise.all(this.listIds().map((id) => this.read(id)));
    return tasks.filter((task): task is SwarmTask =>
      task !== null
      && (filter.workspaceId === undefined || task.workspaceId === filter.workspaceId)
      && (filter.status === undefined || task.status === filter.status)
      && (filter.assignee === undefined || task.assignees.includes(filter.assignee)));
  }

  update(id: string, patch: UpdateTaskPatch): Promise<SwarmTask | null> {
    return this.mutex.run(id, async () => {
      const existing = await this.read(id);
      if (existing === null) return null;
      const next = applyPatch(existing, patch, this.now());
      await this.write(next);
      return next;
    });
  }

  /** Atomically appends one feedback-loop event and bumps `updatedAt`. */
  appendFeedbackEvent(id: string, event: TaskFeedbackEvent): Promise<SwarmTask | null> {
    return this.mutex.run(id, async () => {
      const existing = await this.read(id);
      if (existing === null) return null;
      const next: SwarmTask = {
        ...existing,
        feedbackEvents: [...existing.feedbackEvents, event],
        updatedAt: this.now(),
      };
      await this.write(next);
      return next;
    });
  }

  private path(id: string): string {
    return join(this.baseDir, `${encodeURIComponent(id)}.json`);
  }

  private listIds(): string[] {
    return readdirSync(this.baseDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => decodeURIComponent(file.slice(0, -".json".length)));
  }

  private async read(id: string): Promise<SwarmTask | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as SwarmTask;
    } catch {
      return null;
    }
  }

  private write(task: SwarmTask): Promise<void> {
    return atomicWriteJSON(this.path(task.id), task);
  }
}

/**
 * Returns a new task with the patch applied. Absent fields are left untouched;
 * an explicit `null` on a nullable field clears it (tri-state, matching the
 * Rust `Option<Option<T>>` patch fields). Pure — never touches disk.
 */
function applyPatch(task: SwarmTask, patch: UpdateTaskPatch, now: number): SwarmTask {
  const next: SwarmTask = { ...task, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.goal !== undefined) next.goal = patch.goal;
  if (patch.knowledge !== undefined) next.knowledge = patch.knowledge;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.teamId !== undefined) next.teamId = patch.teamId;
  if (patch.assignees !== undefined) next.assignees = patch.assignees;
  if (patch.subtasks !== undefined) next.subtasks = patch.subtasks;
  if (patch.intake !== undefined) next.intake = patch.intake;
  if (patch.feedbackEvents !== undefined) next.feedbackEvents = patch.feedbackEvents;
  if (patch.cellId !== undefined) setOrClear(next, "cellId", patch.cellId);
  if (patch.lastError !== undefined) setOrClear(next, "lastError", patch.lastError);
  if (patch.dueDate !== undefined) setOrClear(next, "dueDate", patch.dueDate);
  if (patch.blocker !== undefined) setOrClear(next, "blocker", patch.blocker);
  return next;
}

/** Sets a nullable optional field, or deletes it when the incoming value is null. */
function setOrClear<K extends "cellId" | "lastError" | "dueDate" | "blocker">(
  task: SwarmTask,
  key: K,
  value: NonNullable<SwarmTask[K]> | null,
): void {
  if (value === null) delete task[key];
  else task[key] = value;
}
