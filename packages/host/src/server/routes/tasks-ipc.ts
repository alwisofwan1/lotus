import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteHandler } from "../router.js";
import type { SwarmTaskStore } from "../tasks/store.js";
import type { SwarmTask, TaskFeedbackEvent, TaskStatus, UpdateTaskPatch } from "../tasks/types.js";
import { readJson } from "./utils.js";

/** Match desktop task IPC so one MCP sidecar can drive either host (ADR-0019). */

interface CreateBody {
  workspace_id?: string;
  title?: string;
  goal?: string;
  knowledge?: string;
  assignees?: string[];
  status?: TaskStatus;
}
interface UpdateBody { workspace_id?: string; task_id?: string; patch?: UpdateTaskPatch }
interface AppendBody { workspace_id?: string; task_id?: string; event?: TaskFeedbackEvent }
interface ListBody { workspace_id?: string; status?: TaskStatus; assignee?: string }
interface GetBody { workspace_id?: string; task_id?: string }

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const ok = (res: ServerResponse, extra: Record<string, unknown>): void => send(res, 200, { ok: true, ...extra });
const bad = (res: ServerResponse, error: string): void => send(res, 400, { error });
const notFound = (res: ServerResponse, id: string): void => send(res, 404, { error: `Task not found: ${id}` });

/** Reads the JSON body, replying 400 and returning null on malformed input. */
async function body<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    return await readJson<T>(req);
  } catch {
    bad(res, "Invalid JSON body");
    return null;
  }
}

/** Loads a task only if it exists AND belongs to the given workspace. */
async function scopedTask(
  store: SwarmTaskStore,
  workspaceId: string,
  taskId: string,
): Promise<SwarmTask | null> {
  const task = await store.get(taskId);
  return task !== null && task.workspaceId === workspaceId ? task : null;
}

export function createTaskHandler(store: SwarmTaskStore): RouteHandler {
  return async (req, res) => {
    const b = await body<CreateBody>(req, res);
    if (!b) return;
    if (!b.workspace_id || !b.title || !b.goal) {
      bad(res, "workspace_id, title, and goal are required");
      return;
    }
    const task = await store.create({
      workspaceId: b.workspace_id,
      title: b.title,
      goal: b.goal,
      ...(b.knowledge !== undefined ? { knowledge: b.knowledge } : {}),
      ...(b.assignees !== undefined ? { assignees: b.assignees } : {}),
      ...(b.status !== undefined ? { status: b.status } : {}),
    });
    ok(res, { task });
  };
}

export function updateTaskHandler(store: SwarmTaskStore): RouteHandler {
  return async (req, res) => {
    const b = await body<UpdateBody>(req, res);
    if (!b) return;
    if (!b.workspace_id || !b.task_id) {
      bad(res, "workspace_id and task_id are required");
      return;
    }
    if (!(await scopedTask(store, b.workspace_id, b.task_id))) {
      notFound(res, b.task_id);
      return;
    }
    const task = await store.update(b.task_id, b.patch ?? {});
    if (!task) return notFound(res, b.task_id);
    ok(res, { task });
  };
}

export function appendTaskFeedbackEventHandler(store: SwarmTaskStore): RouteHandler {
  return async (req, res) => {
    const b = await body<AppendBody>(req, res);
    if (!b) return;
    if (!b.workspace_id || !b.task_id || !b.event) {
      bad(res, "workspace_id, task_id, and event are required");
      return;
    }
    if (!(await scopedTask(store, b.workspace_id, b.task_id))) {
      notFound(res, b.task_id);
      return;
    }
    const task = await store.appendFeedbackEvent(b.task_id, b.event);
    if (!task) return notFound(res, b.task_id);
    ok(res, { task });
  };
}

export function listTasksHandler(store: SwarmTaskStore): RouteHandler {
  return async (req, res) => {
    const b = await body<ListBody>(req, res);
    if (!b) return;
    if (!b.workspace_id) {
      bad(res, "workspace_id is required");
      return;
    }
    const tasks = await store.list({
      workspaceId: b.workspace_id,
      ...(b.status !== undefined ? { status: b.status } : {}),
      ...(b.assignee !== undefined ? { assignee: b.assignee } : {}),
    });
    ok(res, { tasks });
  };
}

export function getTaskHandler(store: SwarmTaskStore): RouteHandler {
  return async (req, res) => {
    const b = await body<GetBody>(req, res);
    if (!b) return;
    if (!b.workspace_id || !b.task_id) {
      bad(res, "workspace_id and task_id are required");
      return;
    }
    const task = await scopedTask(store, b.workspace_id, b.task_id);
    if (!task) return notFound(res, b.task_id);
    ok(res, { task });
  };
}
