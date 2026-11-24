# ADR-0031: CodeCanvas voice output settings + agent-done callouts (reuse-first)

- **Status:** Accepted
- **Date:** 2026-06-29
- **Builds on:** ADR-0028 (BYOK TTS voice feedback), ADR-0029 (live-agent feedback loop), ADR-0022/0024 (live agent personas), ADR-0027 (runner-first launch)
- **Supersedes parts of:** the "always speak on success" behaviour from ADR-0028

## Context

The reference design (CNVS "Voice" settings) centres voice on **GPT Realtime**
(speech-to-speech), **Grok/xAI TTS**, an **on-device grammar with a Groq fast
fallback**, and a **VOICE OUTPUT** section with toggles (*Speak replies*, *"Agent is
done" callouts*, *Wake on agent finish*, *Voice picker*). Our shipped architecture is
deliberately different and was just hardened this cycle: BYOK STT (browser / OpenAI /
Deepgram) + TTS (browser / OpenAI / ElevenLabs), a Haiku NL planner, push-to-talk, keys
in `~/.lotus/*.json` (0600). Earlier this cycle the user chose **Option A — stability
first**, explicitly deferring GPT Realtime (cost + vendor lock-in + WebRTC complexity).

We want the reference's *output controls* without adopting its provider lineup or
reversing the Realtime deferral. A deep research pass (3 agents) inventoried what can be
**reused** versus built.

Key research findings:

- **"Agent finished a task" has no first-class event.** Five candidate signals exist:
  1. **OSC 133 `is_shell_idle`** (`pty.rs`) — true semantic idle (shell/TUI reports
     PromptStart/CommandDone). Zero false positives *when available*, but it is **not
     exposed over IPC** and depends on shell-integration (Claude Code / Codex TUIs emit
     it; plain shells do not).
  2. **`PtyOutputMetrics.idle_ms`** (Rust ring buffer) — reliable elapsed-time substrate,
     already exposed via `getPtySessionMetrics`.
  3. **`useCellIdleWatcher`** — a tested busy→idle state machine over `idle_ms` (default
     8s, guards startup-silence false positives); codespace-only today.
  4. **`AgentStatusRegistry` `completed`** — means the **PTY process exited**, NOT that a
     turn finished. A live REPL agent rarely exits, so this is the wrong signal.
  5. **`lotus_wait_cell_idle`** — a "ready to receive input" classifier, not turn-done.
- **Cheap spoken text already exists:** the pane-title pipeline derives a short summary
  from the latest prompt / Claude JSONL with **no model cost** (model tail-summary is
  opt-in only). It is codespace-only today.
- **Settings storage:** the `TtsProviderRegistry` (`~/.lotus/tts-providers.json`, 0600,
  with `useTtsProviderRegistry` + a change-event) is the natural, lowest-churn home for
  output preferences.

## Decision

Build the reference's **VOICE OUTPUT** controls on our **current** engine, reusing
existing infrastructure. GPT Realtime / Grok / Groq / on-device grammar remain **out of
scope** (Option A); the reference's "GPT Realtime ready" status pill becomes a neutral
**"Voice ready"** reflecting the active TTS provider.

1. **Settings storage — reuse the TTS registry.** Add an optional `output` block to
   `TtsProviderRegistry`:
   `output { speakReplies: bool, agentDoneCallouts: bool, wakeOnFinish: bool, voiceId?: string }`
   (defaults: `speakReplies=true`, `agentDoneCallouts=true`, `wakeOnFinish=false`).
   Persists in `~/.lotus/tts-providers.json`; reuses the existing Rust commands, the
   `TTS_PROVIDERS_CHANGED_EVENT`, and `useTtsProviderRegistry`. No new store or module.

2. **Speak gate — one place.** A master `speakReplies` gate lives inside
   `use-voice-feedback.ts`; existing `speak?.()` call sites stay unchanged.

3. **Turn-done trigger — reuse the idle watcher, NOT process exit.** Detect "agent
   finished a turn" by reusing the `useCellIdleWatcher` busy→idle algorithm per
   `LiveAgentNode` (fed by `getPtySessionMetrics` `idle_ms`). **Do not** use
   `AgentStatusRegistry.completed` (that is session-exit). **Hardened upgrade
   (follow-up):** expose the existing OSC 133 `is_shell_idle` `AtomicBool` over IPC
   (~10 lines Rust) and use it as the *semantic primary*, with the `idle_ms` heuristic as
   the fallback for runners without shell-integration.

4. **Callout text — plain now, reuse summary later.** MVP speaks `"{name} is done."`.
   Follow-up: reuse the pane-title cheap-summary derivation (no model cost) for
   `"{name} finished: <summary>"`; this requires wiring the pane-title derivation to
   canvas nodes (codespace-only today).

5. **Visible vs background.** `background` = node outside the viewport; `visible` = inside
   it. `agentDoneCallouts` announces **background** completions; `wakeOnFinish` extends
   announcements to **visible** ones too (its meaning under Option A, with no Realtime).

6. **Recommended provider defaults.** STT: OpenAI **`gpt-4o-transcribe`** (accuracy +
   prompt-biasing; set as the built-in default). TTS: OpenAI **`gpt-4o-mini-tts`** as the
   balanced default, **ElevenLabs `eleven_turbo_v2_5`** for premium naturalness. Voice
   picker: OpenAI's 6 known voices hardcoded, ElevenLabs free-text voice id, browser
   voices from `getVoices()`.

7. **UI — extend the existing `VoiceTab`.** Add a "Voice output" section (the four
   controls) below the provider list; keep our providers; relabel the status pill to
   "Voice ready".

## Consequences

- **Positive:** ships on the current, hardened engine with near-zero new infrastructure;
  no vendor lock-in; deterministic; the "done" signal is correct (turn-done, not exit);
  spoken text can become informative for free later.
- **Negative / risks:** the heuristic trigger can mis-fire "done" if an agent pauses
  ≥ idle-threshold mid-turn (mitigated by the OSC 133 upgrade); pane-title reuse on the
  canvas is non-trivial (codespace-coupled today); "wake on finish" is a reduced form of
  the reference (no proactive Realtime speech).
- **Reversibility:** all decisions are additive; GPT Realtime can later be added as
  another BYOK provider behind the same `output` settings without rework.

## Alternatives considered

- **Adopt the reference lineup (GPT Realtime + Grok + Groq).** Rejected for now —
  reverses Option A; high cost, lock-in, WebRTC session complexity.
- **Use `AgentStatusRegistry.completed` as the done signal** (research's "least friction"
  pick). Rejected — it is process-exit, semantically wrong for "finished a task".
- **Build a new completion event end-to-end.** Rejected — the idle watcher + OSC 133
  already encode this; reuse beats rebuild.
- **Store toggles in `~/.claude/settings.json`.** Rejected — these are TTS-specific, not
  global IDE prefs; the TTS registry is the cohesive home.
