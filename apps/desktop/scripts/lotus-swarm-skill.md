---
name: swarm
description: Split a larger coding task across several sub-agents that work in parallel, each in its own git worktree, each checked by a verifier on the other provider, then report what passed and what to merge. Use when the user types /swarm, or asks to "swarm", "split this across agents", "pecah ke beberapa agent", "kerjakan paralel", or hands over a list of independent fixes. Runs inside Lotus Chat only.
---

# Swarm

You are the **lead**. You split the task, brief the workers, wait for them, and report. The workers
do the work. Lotus runs the rest in code: each worker's verifier, sending a failed check back to its
worker, and pausing a worker that runs out of quota.

It is built from the Lotus Chat tools: `lotus_chat_delegate`, `lotus_chat_wait`, `lotus_chat_answer`,
`lotus_chat_tell`, `lotus_chat_stop`, `lotus_chat_merge`, `lotus_chat_discard`. If they are not
loaded, load them first (Claude: ToolSearch `lotus_chat`). If they do not exist at all, you are not
in a Lotus Chat thread: say so and stop.

The task is whatever follows `/swarm`. If nothing follows, ask for it in one line.

## 1. Split

Read enough of the code to split the work well. Then cut it into pieces that:

- **touch different files.** Two workers editing one file make a merge conflict. Split by package or
  module, not by kind of change.
- **stand alone.** A worker never sees this conversation or the other workers.
- **are worth a session.** A one-line change is cheaper done yourself than delegated. Usually 2–5
  workers. Never more than the user asked for.

If the user already listed the pieces, or said to go ahead, launch. Otherwise show the split first
and ask once:

```
Swarm plan (3 workers, each verified):
1. <title> — <provider/model> — <files or package>
2. …
Launch?
```

## 2. Launch

Start **every** worker before you wait on any. Use one `lotus_chat_delegate` call per worker:

- `provider` / `model` / `effort`: what the user named. Otherwise, pick what the piece needs.
  Spreading workers across `claude` and `codex` is fine; the verifier is always the other provider.
- `worktree: true` for any worker that changes files.
- `verify: true` for code that changes behaviour. Leave it off for read-only, research and mechanical
  pieces (comments, renames, formatting): each round runs a second agent at high effort.
- `effort`: never `low` for a piece that spans many files; a low-effort worker tends to give up early.
- `title`: short, shown in the rail.
- `prompt`: the whole brief, self-contained. Use this shape:

```
Goal: <one sentence>.
Scope: <files/package>. Do not touch anything outside it.
Context: <what you learned that the worker needs: file:line, the bug, the constraint>.
Done when: <observable result>, the full test suite of the package you touched passes, and the
work is committed on your branch.
Rules: fix the root cause, not the symptom. Add or adjust a test that fails without your change
(deleting dead code needs no new test; a green build is the evidence). End with a short report:
what changed, file:line, and the test command you ran.
```

## 3. Wait

Call `lotus_chat_wait` with **all** worker chatIds and `timeoutSec: 1800`. Repeat while it returns
`timedOut: true`. Between calls, tell the user one line of progress. Each worker has a status:

- `working` / `starting`: keep waiting.
- `waiting`: read `waitingOn`.
  - A question: answer it with `lotus_chat_answer` if the user's task already answers it, otherwise
    ask the user.
  - A permission: only the user can grant it. Tell them which worker (by title) needs it.
  - An entry with a `chatId` belongs to that worker's verifier.
- `paused`: the worker is out of quota. Lotus sends it on by itself at `resetsAt`. Tell the user the
  time, and keep waiting or end your turn.
- `done`: the worker's final report is in `text`.

## 4. Judge

For each worker, look at `verify.status`:

- `passed`: a verifier on the other provider re-ran the tests and agreed. Ready to merge. Its
  non-blocking `Notes:` are in the verifier's chat; mention them only if they matter.
- `blocked`: the worker said it could not finish; `reasons` says why. No verifier ran. Fix the brief
  (smaller piece, missing context) and `lotus_chat_tell` it, or report it.
- `unverified`: the rounds ran out, or the verifier could not finish. Read `reasons`.
  - If a reason is clear and inside the worker's scope, send one more `lotus_chat_tell` with it,
    then wait again.
  - Otherwise, report it as not ready.
- `interrupted`: the worker was stopped or deleted.
- `null`: Lotus restarted and the check was lost. Report the work as unchecked.

Do not re-run a verifier's work yourself. Do not override its verdict without saying so.

## 5. Report

```
**Swarm: 2 of 3 ready to merge.**

| Worker | Verify | Branch | Note |
|---|---|---|---|
| <title> | passed r1 | lotus/d-… | <one line> |
| <title> | unverified 3/3 | lotus/d-… | <the reason that is left> |

Next: merge <titles>? (I merge only when you say so.)
```

**Merging is the user's decision.** Run `lotus_chat_merge` only when they ask, one worker at a time.
Merge in an order that avoids conflicts, and stop at the first refusal. `lotus_chat_discard` drops
a worker's branch, its chat and its verifiers; use it only when asked.

## Do not

- Do not make workers talk to each other or share a scratch file. Every message goes through you.
- Do not delegate a piece without `worktree: true` while another worker writes files.
- Do not report success on work whose verify is not `passed`.
