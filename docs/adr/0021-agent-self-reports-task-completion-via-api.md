# ADR 0021 — Agents self-report task completion to `in-review` via the Canvas Agent API

**Status**: Accepted

## Context

When a **Canvas Task Node** that is backed by a **Swarm Task** (`taskId` present) is dispatched, the agent doing the work is the only party that knows when it has finished. Today nothing closes the loop: the human must remember to move the task forward by hand, so dispatched tasks silently sit in `in-progress`.

The **Task Dispatch Prompt** already rides on the env that ADR 0011 injects into canvas PTY sessions (`AGENT_CANVAS_API` + `AGENT_CANVAS_API_KEY`), and the axum task API exposes `PATCH /api/tasks/:id`.

## Decision

The Task Dispatch Prompt ends with a **Task Completion Callback** — a `curl` the agent runs on finish:

```
PATCH $AGENT_CANVAS_API/api/tasks/<taskId>
Authorization: Bearer $AGENT_CANVAS_API_KEY
{"status":"in-review"}
```

The callback is emitted only when the task carries a backend `taskId`, and the target status is **`in-review`**, not `complete` — the agent hands work back for a human gate rather than self-certifying it done.

## Considered options

- **`manualReviewDone: true` to `POST /api/task/update`** (the shape originally sketched): rejected — no such route or field exists; it would 404.
- **Set status to `complete`**: rejected — removes the human review gate; an agent declaring its own work done is exactly what we don't want.
- **An MCP tool instead of `curl`**: rejected per ADR 0011 — the prompt must work from any PTY/`curl`, not only inside a Claude CLI MCP session.
- **No callback; human moves the task**: rejected as the status quo we're fixing.

## Consequences

- Copy Prompt carries the same callback for consistency; pasted outside a canvas PTY the env vars are unset and the `curl` is a harmless no-op.
- The contract (method, path, `in-review` status, Bearer auth) is now embedded in dispatched prompts — changing it ripples to every in-flight agent run, so it is versioned here.
- Canvas-only tasks (no `taskId`) get the brief without a callback; nothing to update.
