# 0029 — CodeCanvas Phase D: bounded live-agent feedback loop (tiered verdict, independent critic)

- **Status:** Proposed
- **Date:** 2026-06-29
- **Related:** ADR-0024 (live terminal personas), ADR-0025 (Agent Runtime Kernel), ADR-0027 (runner-first launch), ADR-0026 (CodeCanvas standalone ADE). Plan: `plans/codecanvas-nl-full-coverage/` (NL Intent Registry, `make_lead`, `formatTaskEnvelope`). Spec artifact: Phase D rev. C.
- **Decided via:** design review + web research, 2026-06-29 (this ADR records the answers)

## Context

CodeCanvas can spawn live runner agents (ADR-0027), dispatch to them, and promote one to a lead
(`make_lead`). The remaining roadmap pillar is the **"loop"** — an agent that iterates on its work
until it is good enough. This is the CNVS-style `Worker → Critic → (on fail) back to Worker` cycle.

Two clarifications shaped the decision:

1. **It is a graph loop, not cron.** The "loop" means *iterate-until-condition*, not a schedule.
   Scheduling is explicitly rejected: a cron that spawns agents has no natural cost bound.

2. **It is the LIVE plane, not the headless run.** The repo has two agent planes:
   - **Headless graph run** — `HeadlessAgentNode` / `CriticNode` / `HumanGateNode` register with
     `agentRunRegistry` and flow through `CanvasRunScheduler` (a topological DAG executor; a cycle is
     a deadlock; the critic only `block()`s downstream).
   - **Live terminal plane** — `LiveAgentNode` is a persistent PTY session (NL bar `spawn_agent`,
     `dispatch`, `make_lead`). It **never** registers with `agentRunRegistry` and **never** flows
     through `CanvasRunScheduler`.

   The loop targets the **live plane** (the direction the product is built around). Therefore Phase D
   is a **new controller**, not a change to `CanvasRunScheduler`.

**The landmine — research.** The naive design ("a live critic LLM reads the worker's terminal and
says pass/fail") is the single weakest possible mechanism. The literature is consistent:
- LLMs largely **cannot self-correct** without genuine external feedback, and **self-bias amplifies
  monotonically** across refinement turns (fluency rises, correctness stalls).
- **LLM-as-judge is self-biased and overconfident**; if worker and critic share a model, scores
  inflate while real quality stagnates — reward hacking.
- Loop engineering's first principle is a **verifiable reward signal**: *"LLMs have no built-in
  concept of done"* — define completion with deterministic checks, **not** agent self-assessment.

So the verdict mechanism — not the loop wiring — is where this feature lives or dies.

## Decision

Build a bounded live-agent feedback loop driven by a **new Live Loop Controller**, with a
**tiered, verifiable verdict** and an **independent critic**.

1. **New controller, not the scheduler.** An async, event-driven **Live Loop Controller** drives the
   loop over live PTY sessions. `CanvasRunScheduler` is untouched. (Live agents are persistent
   sessions, not synchronous one-shot DAG nodes.)

2. **The loop is a declared back-edge.** A loop is `Worker → Verdict` (forward) + `Verdict → Worker`
   (loop-back, `CanvasEdgeRecord.kind = "loop"`, `data.maxIterations`). **Declared-only** — there is
   no way to create an autonomous live loop by accident; an undeclared cycle is not a loop.

3. **Tiered verdict (the core decision).** "Done" is judged in two tiers, deterministic first:
   - **Tier 1 — deterministic checks.** Where they exist (tests / build / lint / type-check / an
     expected artifact), the check's **exit code is the verdict**. Ungameable, un-flatterable; if it
     decides the criteria, no LLM votes.
   - **Tier 2 — independent critic.** For the subjective remainder only, a critic on a **different
     runner/model than the worker** (ADR-0027 makes runner choice first-class), prompted
     adversarially to find faults. Its **PASS is treated skeptically**; its FAIL feedback drives the
     next turn. Same-model self-grading is forbidden.

4. **Verdict via a deterministic channel.** The verdict arrives as a check exit code, or the critic
   writing a **structured result to a known file/artifact** (or a headless one-shot critic's result
   event) — **never** by scraping free-form terminal text. An **unreadable verdict counts as FAIL**;
   the loop never passes by accident.

5. **Verifiable done-condition required at creation.** A loop cannot start without explicit criteria,
   deterministic where possible. No vague "make it good."

6. **Same-session feedback, re-anchored each turn.** On FAIL, the controller re-dispatches into the
   **same** worker session via `sendAgentMessage` + `formatTaskEnvelope` (context preserved — the
   live-plane advantage), and **re-anchors the original done-criteria every turn** to counter
   self-bias amplification and goal drift in long sessions.

7. **Turn boundary = idle + timeout.** A turn is "done" when the worker goes `running → idle`
   (`agentStatusRegistry` + the existing `wait-cell-idle` detection), bounded by a **per-turn
   timeout**; a timeout counts as a turn boundary so a never-idle session cannot stall the loop.

8. **No-progress → strategy reset.** If feedback repeats or the worker's output is unchanged across
   turns, the loop **does not grind to max**: it escalates to a fresh-context retry (Ralph-style) or
   stops. (Inner/outer-loop pattern — escape "insistent failure.")

9. **Guardrails are mandatory** (not optional): max iterations (default 3, hard cap e.g. 10);
   per-turn timeout + per-loop wall-clock/token budget (live agents hang; cost ≈ 4–15× a single run);
   **session lock** (manual dispatch can't race a running loop); **always-on kill switch**;
   **exhaustion is a visible failed state**, never silent success; **human gate before irreversible
   actions** (deploys / external writes), routine file work contained by per-agent **worktree
   isolation** (ADR-0015) — which also makes Tier-1 checks safe to run.

10. **NL surface lands last.** A `create_loop` Intent Registry entry is added **only after** the
    controller works, keeping the NL schema a mirror of capability (schema ⊆ capability).

## Consequences

**Positive**
- The worker stays a live CNVS-style agent ("watch it work"), with context preserved across tries.
- The verdict is hardened against the two documented failure modes (self-bias amplification, reward
  hacking): deterministic-first + independent critic + skeptical PASS.
- `maxIterations` + budget + no-progress + kill switch give a hard, visible cost ceiling — the direct
  answer to the runaway / AI-slop worry.
- Reuses `sendAgentMessage`, `formatTaskEnvelope`, `agentStatusRegistry`, `wait-cell-idle`, worktree
  isolation — little new under the hood; `CanvasRunScheduler` untouched.

**Negative / risks**
- **Turn-boundary detection is heuristic** on a PTY (idle ≠ guaranteed "done"). Mitigated by
  signatures + timeout, but it is the linchpin risk — validated by a spike before the controller.
- **Tier-1 isn't always available** (subjective tasks). Then the loop leans on Tier-2, which is
  weaker; the skeptical-PASS + independent-model rules bound the damage.
- A second model (critic) raises per-loop cost; the budget guardrail caps it.
- Live-critic verdict transport is fuzzier than a headless result — hence the file/exit-code channel,
  with a headless critic as the fallback if parsing proves unreliable.

**Domain language (CONTEXT.md)**
- **Live Loop Controller**, **loop-back edge** (`kind:"loop"`), **tiered verdict** (deterministic /
  independent critic), **turn boundary**, **no-progress / strategy reset**, **exhausted** (loop
  state) added. "Critic" in the live context = an **independent** runner, distinct from the headless
  `CriticNode`.

## Build order (all Proposed)

| Step | Scope | Status |
|---|---|---|
| 1 | This ADR — semantics + guardrail contract | ✅ (this doc) |
| 2 | **Turn-boundary spike** — validate idle/"turn done" + per-turn timeout (riskiest, first) | ⏳ |
| 3 | Tier-1 deterministic verdict — run a check against the worker's worktree; exit code = verdict | ⏳ |
| 4 | Tier-2 independent critic — different runner + adversarial prompt + structured-result transport | ⏳ |
| 5 | Live Loop Controller — dispatch → wait → verdict → decide; no-progress, kill switch, session lock | ⏳ |
| 6 | Loop edge + UI — `kind:"loop"` back-edge + `maxIterations`; iteration counter, cost, exhausted, Stop | ⏳ |
| 7 | Tests — pass-exit, fail-redispatch, no-progress-reset, exhaustion-blocks, timeout-boundary, unreadable-verdict-never-passes | ⏳ |
| 8 | NL `create_loop` Intent Registry entry (after the controller lands) | ⏳ |

## Research grounding

- Self-correction limits + self-bias amplification: *Large Language Models Cannot Self-Correct
  Reasoning Yet* (arXiv 2310.01798); *Pride and Prejudice: LLM Amplifies Self-Bias in Self-Refinement*
  (arXiv 2402.11436).
- LLM-as-judge self-bias / overconfidence: *Play Favorites* (arXiv 2508.06709); Galileo,
  *LLM-as-a-Judge vs Human Evaluation*.
- Loop-engineering guardrails + verifiable reward signal: Data Science Dojo, *Agentic Loops: From
  ReAct to Loop Engineering (2026 Guide)*; AWS, *Evaluator reflect-refine loop patterns*
  (inner/outer strategy reset).
- Pattern lineage: *Self-Refine* (selfrefine.info), Reflexion.
