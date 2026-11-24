"use client";

import { Check, ChevronRight } from "lucide-react";
import { useState } from "react";

import type { PlanTask } from "../domain/plan";
import { KawungBar } from "./Kawung";

/** The agent's task list as the composer's top line: progress, what it is on now, the count. Opens to the list. */
export function ChatPlan({ tasks }: { tasks: readonly PlanTask[] }) {
  const [open, setOpen] = useState(false);
  const done = tasks.filter((t) => t.status === "done").length;
  const active = tasks.find((t) => t.status === "active");
  const finished = done === tasks.length;
  return (
    <div className="chat-plan" data-open={open || undefined} data-done={finished || undefined}>
      <button type="button" className="chat-plan-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <KawungBar className="chat-plan-bar" progress={done / tasks.length} />
        <span className="chat-plan-now">
          {finished ? `All ${tasks.length} tasks done` : active ? `${active.activeForm}…` : `${tasks.length - done} tasks left`}
        </span>
        <span className="chat-plan-count" aria-label={`${done} of ${tasks.length} done`}>
          {done}/{tasks.length}
        </span>
        <ChevronRight className="chat-plan-chevron" size={12} aria-hidden />
      </button>
      {open && (
        <ol className="chat-plan-list">
          {tasks.map((task, i) => (
            <li key={i} data-status={task.status}>
              <span className="chat-plan-tick" aria-hidden>
                {task.status === "done" && <Check size={8} strokeWidth={3.5} />}
              </span>
              <span>{task.content}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
