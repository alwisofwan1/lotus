# The orchestrator is provider-portable; headless billing drives runtime choice

## Status

accepted (amends the runtime scope of [ADR-0019](./0019-standalone-host-as-headless-agent-driven-orchestrator.md))

**Decision stands; its premise did not happen.** The billing change this ADR was
written against was withdrawn before it took effect — see
[the 2026-08-07 addendum](#addendum-2026-08-07--the-billing-change-never-took-effect)
before acting on anything in the Context or Cost-posture sections below.

## Context

ADR-0019 specified the **Headless Director** as a `claude --resume --print`
session and scoped V1 to claude only. A platform billing change makes a
single-provider always-on orchestrator economically fragile.

**Anthropic billing change, effective 15 June 2026** (verified, June 2026):

- `claude -p` (headless / print mode), the Claude Agent SDK, Claude Code GitHub
  Actions, and third-party apps authenticating with a Claude subscription **stop
  drawing from the subscription usage pool**. They instead consume a **separate
  monthly dollar credit** billed at standard API rates: **$20 Pro / $100 Max 5x /
  $200 Max 20x**, per-user, reset monthly, **no rollover**; automation halts when
  the credit is exhausted unless overflow billing is enabled.
- **Interactive Claude Code** (terminal/IDE TUI) is **explicitly unaffected** and
  continues to draw from the subscription limits.

Two consequences for our architecture:

1. The **Headless Director** path (`claude ... --print`) now bills against the
   capped credit pool. An always-on orchestrator that recurses and re-invokes is
   exactly the workload the change targets.
2. **Worker cells already run as interactive PTY sessions** (`spawnPty` types
   `claude --dangerously-skip-permissions` into a TUI), which is the *interactive*
   code path and therefore subscription-funded. NOTE: routing automation through
   the interactive TUI to avoid the credit pool is a **grey area** — Anthropic's
   intent is to bill automation regardless. It is not a sanctioned workaround and
   must not be relied on without checking the Terms.

**Codex** is not subject to the Anthropic credit pool (funded by ChatGPT
subscription or OpenAI API) and is capable of the Director role: `codex exec`
runs headless to completion, **supports resume** (`codex exec resume --last` /
`<id>`) for the event-driven loop, loads **MCP servers** via
`~/.codex/config.toml`, and bypasses non-interactive approval prompts with
`--dangerously-bypass-approvals-and-sandbox` (already used on the desktop codex
path) plus `--ignore-user-config` / `--ignore-rules` for controlled automation.

## Decision

- The orchestrator is **provider-portable**: both the **Headless Director** and
  worker cells are driven through the existing **Agent Runner** abstraction, with
  **claude and codex as first-class runtimes**. The runtime is selectable per
  deployment (and ideally per task), not hardcoded.
- The **MCP-IPC Contract** (`/v1/*`) is the provider-neutral seam: the standalone
  host serves it once; claude loads the sidecar via its MCP-config flag and codex
  loads the same sidecar via `config.toml`. Contract parity holds across
  providers — there is still one task store and one tool surface.
- **Cost posture, by default:**
  - Keep worker cells on **interactive PTY** where the runtime is claude (cheapest
    path), with the grey-area caveat documented above.
  - Allow the **Director** to run on **codex** to sidestep the Anthropic credit
    pool entirely, or on claude (credit pool, bounded by the event-driven model)
    when claude is preferred.
- Per-provider concerns that must be wired for Director parity: the **resume
  substrate** (claude `--resume` vs `codex exec resume`), **MCP loading** (claude
  `--mcp-config` vs codex `config.toml`), and the **readiness / output parser**
  (claude stream-json vs codex `--json` events) — the desktop already has both
  adapters; reuse their shapes.

## Consequences

- The orchestrator survives a provider's policy/pricing shift by switching
  runtime, not rewriting orchestration — the agent-driven, contract-parity design
  makes the brain portable.
- Real scope increase over ADR-0019's claude-only Director: a codex Director slice
  (exec + resume + `config.toml` MCP + bypass flags + readiness adapter) joins the
  plan. ccs remains a worker-only runtime for now.
- The cost-exposed surface is narrowed to **Director `--print` calls when the
  runtime is claude**; workers (interactive PTY) and a codex Director avoid the
  Anthropic credit pool.
- A new dependency on **honest billing accounting**: the system should make the
  active runtime and its funding source visible to the operator, so credit
  exhaustion (claude) or API spend (codex) is never a silent surprise.
- The grey-area interactive-PTY billing assumption is a **risk, not a feature**:
  if Anthropic closes it or the Terms forbid it, the codex Director / API-key
  path is the fallback already in place.

## Addendum 2026-08-07 — the billing change never took effect

Everything above the line is left exactly as written. It was true as an account of
what had been *announced*, and rewriting it would make this document lie about what
was known when the decision was taken. What follows is what is true now.

**Anthropic withdrew the change on the day it was due to start.** Announced
2026-05-14, scheduled for 2026-06-15, and pulled on 2026-06-15 — the separate
monthly credit for the Agent SDK, `claude -p`, GitHub Actions and third-party apps
is, in Anthropic's own words, *"no longer happening"*. Programmatic usage continues
drawing from Pro / Max / Team / Enterprise subscription limits exactly as before.
The $20 / $100 / $200 credits never activated. Verified 2026-08-07 against two
independent write-ups quoting the same help-centre confirmation
([aicodex](https://www.aicodex.to/articles/claude-subscription-credit-changes),
[codersera](https://codersera.com/blog/anthropic-june-2026-billing-change-claude-code/)).

Anthropic says it is **reworking** the plan rather than abandoning the idea, and has
committed to advance notice before any revised version ships.

### What this changes

- **The Context section's central fact is stale.** `claude -p` is *not* billed from a
  capped credit pool today. Any reasoning that starts "headless costs extra" is
  reasoning from a change that was cancelled.
- **The cost posture is no longer forced.** Keeping worker cells on interactive PTY
  and pushing the Director onto codex were chosen to dodge a pool that does not
  exist. Both remain defensible on other grounds — PTY personas are the default for
  architectural reasons (ADR-0024), and codex parity is worth having — but **cost is
  no longer the argument for either**, and must not be cited as one.
- **The grey area is moot for now.** Routing automation through the interactive TUI
  was flagged as an unsanctioned workaround against the credit pool. With no credit
  pool, there is nothing being worked around. If the reworked version lands, this
  paragraph becomes live again — do not delete it.

### What this does not change

- **The decision itself.** Provider portability was the right call and is now better
  described as *insurance* than as *mitigation*: a vendor that announced a
  subscription-funding change, scheduled it, and withdrew it on the day is precisely
  the risk this ADR exists to absorb. The reworked version is promised, not
  cancelled.
- **The MCP-IPC contract seam, the resume substrate, and the readiness/parser
  adapters.** All are provider-neutral engineering that stands on its own.
- **"Honest billing accounting."** Still required, and now for a plainer reason: the
  operator should see which runtime is active and what funds it, because that answer
  has already changed once inside a single quarter.

### One thing to fix separately

The parser note in Decision — "the desktop already has both adapters; reuse their
shapes" — is accurate but easy to misread. Both adapters
(`bridge_chat.rs::parse_claude_stream_json`, `packages/host/…/stream-json.ts`,
`packages/host/…/codex-stream.ts`) consume the **whole** stdout buffer and parse it
after the process exits. They read a streaming format in batch. Reusing their shape
gives runtime portability but not incremental output; a Director or a UI that wants
tokens as they arrive needs a line-reader, not these functions. Tracked separately
from this ADR.
