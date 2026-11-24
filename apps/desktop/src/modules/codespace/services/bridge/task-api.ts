import { tauriInvoke } from "@/lib/tauri/runtime";
import type {
  BridgeTask,
  BridgeTaskFeedbackEvent,
  CreateTaskInput,
  TaskListFilter,
  UpdateTaskPatch,
} from "./task-store";

export type BridgeTaskClient = {
  list: (workspaceId: string, filter?: TaskListFilter) => Promise<readonly BridgeTask[]>;
  get: (workspaceId: string, taskId: string) => Promise<BridgeTask | undefined>;
  create: (input: CreateTaskInput) => Promise<BridgeTask>;
  update: (
    workspaceId: string,
    taskId: string,
    patch: UpdateTaskPatch,
  ) => Promise<BridgeTask>;
  /**
   * Add one line to a task's history.
   *
   * Its own command rather than a read-modify-write of `feedbackEvents` from here: an agent may be
   * appending to the same task through the MCP IPC at that moment, and writing the whole array
   * back would drop whatever it wrote. Rust appends under the workspace lock.
   */
  appendEvent: (
    workspaceId: string,
    taskId: string,
    event: BridgeTaskFeedbackEvent,
  ) => Promise<BridgeTask>;
};

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriTaskClient(
  invokeFn: InvokeFn = tauriInvoke as InvokeFn,
): BridgeTaskClient {
  return {
    async list(workspaceId, filter = {}) {
      return await invokeFn<BridgeTask[]>("bridge_list_tasks", { workspaceId, filter });
    },
    async get(workspaceId, taskId) {
      return await invokeFn<BridgeTask | null>("bridge_get_task", { workspaceId, taskId })
        ?? undefined;
    },
    async create(input) {
      return await invokeFn<BridgeTask>("bridge_create_task", { input });
    },
    async update(workspaceId, taskId, patch) {
      return await invokeFn<BridgeTask>("bridge_update_task", { workspaceId, taskId, patch });
    },
    async appendEvent(workspaceId, taskId, event) {
      return await invokeFn<BridgeTask>("bridge_append_task_feedback_event", {
        workspaceId,
        taskId,
        event,
      });
    },
  };
}
