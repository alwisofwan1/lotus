---
name: lotus-tasks
description: "Work a task tracked in Lotus, and report back to it. Triggers on a Lotus task id (task_…), a task key such as TKT-987 or LOT-4, or a prompt carrying a `Report back` block with workspaceId and taskId."
---

# Lotus tasks

You were started by Lotus to work one task. The task is a record other people read: it is where
somebody looks to find out whether this is moving, what you decided, and whether they can stop
watching. Keeping that record true is part of the work, not paperwork after it.

The prompt that started you carries `workspaceId` and `taskId`. Every tool below needs both.

## Work the task

1. **Read the whole record before acting.**

   ```
   lotus_get_task(workspaceId, taskId)
   ```

   It carries the goal, the knowledge, sub-tasks, the blocker if there is one, and everything
   anybody has reported so far. The prompt is a summary of it, not a replacement.

2. **Do the work.**

3. **Report at each real step, not at each command.**

   ```
   lotus_append_task_feedback_event(workspaceId, taskId, event: { id, at, actor: "agent", kind: "agent-result", summary })
   ```

   One entry per meaningful milestone: an investigation that concluded, an implementation ready to
   check, a decision that changes what happens next. Say what changed, what you ran to check it,
   and what is still uncertain. Never narrate command by command — a history that lists every step
   is a log, and nobody reads a log to find out what happened to a task.

4. **Ask for review when the work is done.**

   ```
   lotus_request_task_review(workspaceId, taskId, summary)
   ```

   This moves the task to `in-review`. The summary is what a reviewer reads first, so it should
   name what to look at and where.

5. **If you cannot proceed, say so where it will be seen.**

   ```
   lotus_canvas_mark_blocked(workspaceId, taskId, assignee, summary, blockers)
   ```

   Say what stopped you, what you already tried, and what would unblock it.

## The one rule worth stating outright

**Do not report a blocked task as finished.** The list then tells somebody they can stop looking,
and the work quietly stops being anybody's. A task left honestly blocked is recoverable; a task
falsely closed is not, until somebody notices by accident.

## Sub-tasks

A task may carry a checklist. Its statuses are `pending`, `in-progress`, `completed` — those exact
words, because the store rejects any other. Update them through `lotus_update_task`.

## Statuses

`todo`, `in-progress`, `blocked`, `in-review`, `complete`, `cancelled`.

Use `in-review` when the work is done but still wants a look. Use `complete` only when the task's
own goal is met — and Lotus refuses it unless intake, an agent result, and a passing review verdict
are all on the record.
