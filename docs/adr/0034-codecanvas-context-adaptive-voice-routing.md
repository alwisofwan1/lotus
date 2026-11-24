# ADR-0034: CodeCanvas context-adaptive voice routing (Voice Auto Mode)

- **Status:** Accepted
- **Date:** 2026-07-07
- **Builds on:** ADR-0028 (BYOK TTS + modality-agnostic Intent Registry), ADR-0031 (voice output settings), ADR-0024/0027 (live agents, runner-first launch)
- **Supersedes parts of:** the up-front two-value `VoiceMode` selection in `voice-mode.ts` (`resolveVoiceAction`)

## Context

Today the NL Command Bar makes the user pick a voice mode *before* speaking: ⌘⇧V =
`command` (transcript runs through the NL pipeline), ⌘⇧D = `dictate` (raw transcript to
the single selected agent). `resolveVoiceAction(mode, transcript, settings)` is a pure
seam, but it only knows the pre-selected mode — it is blind to canvas context. The
context that *would* make the choice obvious is already present at the call site but used
narrowly: `finishRecording` reads `selectedAgentNodeId(nodes)` only as a hard
precondition for `dictate` (wrong selection → error), and the command path passes
`selectedNodeIds` to the runner for a few intents.

SuperWhisper's core lesson (Super Mode) is that the user should *speak naturally* and the
system infers intent from context (active app, selected text, clipboard). SuperWhisper
must probe the OS via accessibility APIs. **Lotus owns the equivalent context as ground
truth** — the focused node, its kind, the live fleet, dialogue memory — and, unlike
SuperWhisper, its command path can *act* (spawn/arrange/dispatch), not just emit text.
That combination is the opportunity: one mic that produces the right outcome from context.

## Decision

Introduce **Voice Auto Mode** as the default mic behaviour, backed by a pure **Voice
Intent Router** that reads a **Canvas Voice Context** and the transcript to resolve a
**Voice Outcome**. The two shortcuts remain as explicit overrides.

1. **Voice Intent Router (pure core).** New module
   `services/voice/voice-intent-router.ts` exposing
   `resolveVoiceOutcome(ctx, transcript, settings, forcedMode?) → VoiceOutcome`. It
   **supersedes** `resolveVoiceAction` and absorbs the target-resolution logic currently
   inline in `finishRecording`. `VoiceOutcome` = `command` | `dictate` (with resolved
   `agentId`) | `transform` (rewrite a focused note's selection — Option D, shipped) |
   `insert` | `ignore`. Deletion test: removing it scatters the
   command/dictate/transform/insert branch and target resolution back into the god-component.

   **Conversational repair (Option C, shipped).** An ambiguous single target no longer
   dead-ends in an error: `resolveNodeByName`/`resolveAgentByName` carry their candidates,
   funnelled through the one `nameError` chokepoint into an optional `clarify` on the
   error result. For a single-intent request, `resolveNlIntents` enriches it with a
   composed question + the pending intent; the bar shows candidate chips and, on pick,
   `resolveClarifiedIntents` re-runs the same intent with the other candidates filtered out
   of the pools (so the name resolves uniquely — no override plumbing in the resolvers).
   Multi-intent batches keep a plain error.

2. **Canvas Voice Context (assembled, ground-truth).** A pure builder produces
   `{ focus: {nodeId, kind, name} | null, selectionCount, fleet, dialogue }` from data
   already at the call site — **no new backend plumbing in v1**. A **Focused Node** is the
   single selected node (`selectionCount === 1`). v2 may enrich with clipboard, selected
   note text, and the last agent output tail.

3. **Routing precedence — command verb wins.** In Auto Mode: an explicit canvas-command
   verb always resolves to `command`, *even when an agent is the Focused Node* (so
   "arrange canvas" / "spawn 3 terminals" act on the canvas). Plain prose with an agent
   focused resolves to `dictate` to that agent. To dictate the literal words of a command
   to an agent, use the ⌘⇧D override.

4. **Fast-path first, model only when in doubt.** Routing runs zero-model when it can:
   `matchLocalIntent` catches command verbs; prose-to-focused-agent dictates immediately.
   Only ambiguous/compound utterances escalate to the Haiku planner. Dictation keeps its
   instant, zero-model path — Auto Mode does not add model latency to the common case.

5. **Shortcuts are explicit overrides.** ⌘⇧V forces `command`, ⌘⇧D forces `dictate`,
   bypassing inference (`forcedMode`). The mic button and the saved default become Auto.

5b. **Typed Enter is routed identically.** The router governs the typed submit path too, not
   just the mic — typing prose with an agent focused dictates to it, honoring the predictive
   "→ Rowan" chip. A single focused plain Terminal is likewise an explicit literal-input target:
   typed Enter and Auto voice submit once with native write confirmation, while forced Dictate keeps
   its review-first insert-without-Enter behavior. Explicit typed `tell/ask Terminal … to …` addressing
   resolves the named Terminal without requiring selection or a model call. Canvas command verbs still
   win over context-relative focused-Terminal routing. Without this shared rule the UI promises a focus
   target that only one modality delivers. The word floor is voice-only (a guard against a stray short
   spoken word); typed input runs with `autoSubmit` on and no floor, so it never silently holds for review.

6. **Additive to the Intent Registry.** The Registry stays the single source of truth
   (ADR-0028); Auto Mode is a routing layer in front of it, not a second grammar. It
   composes with the batch-executor and dictation-session extractions (architecture
   review C1/C2) so both text and voice paths share one execution brain.

## Consequences

- **Positive:** the mic "just does the right thing"; context (focused agent, selection)
  becomes first-class instead of a hard precondition; the router is a pure TDD core so
  the outcome matrix (context × transcript × forcedMode) is unit-tested rather than only
  mount-tested; zero added latency on the common dictate/command fast paths; no vendor
  lock-in and no backend changes in v1.
- **Negative / risks:** an utterance that is a *question to the system* ("what agents are
  running?") while an agent is focused will be dictated to that agent under the
  prose-to-focused-agent rule — mitigated by the ⌘⇧V override and, later, by `clarify`
  (Option C). Precedence "command verb wins" means literal-command dictation needs the
  explicit override.
- **Reversibility:** Auto Mode is additive; the forced modes preserve the exact prior
  behaviour, so the change is safe to gate behind a setting and easy to fall back from.

## Alternatives considered

- **Remove the mode toggle entirely (one mic).** Rejected — loses determinism and the
  established ⌘⇧V/⌘⇧D muscle memory; kept as explicit overrides instead.
- **Context only refines target/polish, keep command-vs-dictate modal.** Rejected — the
  smallest change but doesn't deliver the "just talk" reframe.
- **Always route Auto through the Haiku planner (dictation as a fallthrough intent).**
  Rejected for v1 — most consistent but adds model latency to dictation that is instant
  today; revisit if the fast-path rules prove too rigid.
- **Ambiguity always asks back (clarify).** Deferred to Option C (conversational repair);
  precedence rules avoid the friction of asking on every context/content conflict.
