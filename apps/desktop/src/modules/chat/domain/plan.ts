// The agent's own task list (Claude's TodoWrite), shown as one line above the composer. Pure.
// Each TodoWrite call sends the whole list, so the newest call in the last turn is the plan.
// shortcut: Codex sends no plan (`turn/plan/updated` never arrived, see codex/translate.ts); add it if it starts to.

import type { ThreadItem } from "./thread-event";
import type { ThreadState } from "./thread-state";

export interface PlanTask {
  content: string;
  /** What the agent says while on it ("Running the tests"); falls back to `content`. */
  activeForm: string;
  status: "pending" | "active" | "done";
}

export const PLAN_TOOL = "TodoWrite";

export function isPlanItem(item: ThreadItem): boolean {
  return item.kind === "tool" && item.name === PLAN_TOOL;
}

export function latestPlan(state: ThreadState | null): PlanTask[] | null {
  const turn = state?.turns.at(-1);
  if (!turn) return null;
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const { item } = turn.items[i];
    if (item.kind !== "tool" || item.name !== PLAN_TOOL) continue;
    const todos = (item.input as { todos?: unknown } | null)?.todos;
    if (!Array.isArray(todos)) return null;
    const tasks = todos.flatMap((raw): PlanTask[] => {
      const t = raw as { content?: unknown; activeForm?: unknown; status?: unknown } | null;
      if (typeof t?.content !== "string") return [];
      const activeForm = typeof t.activeForm === "string" && t.activeForm ? t.activeForm : t.content;
      const status = t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending";
      return [{ content: t.content, activeForm, status }];
    });
    return tasks.length > 0 ? tasks : null;
  }
  return null;
}
