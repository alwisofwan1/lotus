# 0028 — CodeCanvas voice feedback: speak() contract + BYOK TTS provider architecture

- **Status:** Implemented (architecture + browser default); cloud synthesis is a labeled stub (BYOK, owner-implemented later)
- **Date:** 2026-06-28
- **Related:** ADR-0026 (CodeCanvas standalone ADE), ADR-0027 (runner-first launch), `plans/codecanvas-nl-full-coverage/PLAN.md` (NL Intent Registry, §7 Voice)

## Context

The CodeCanvas NL command bar parses an utterance into intents (Intent Registry) and
executes them. The registry was designed to be **modality-agnostic** so speech (STT/STS)
could drop in later: it already feeds the haiku prompt and the STS tool defs
(`buildRealtimeToolDefs`). Two voice seams were missing: a **spoken-confirmation contract**
and an **output channel** that can speak it. The owner wants real TTS, but will implement
the actual provider calls later with **BYOK** (bring-your-own-key) for OpenAI / ElevenLabs /
others. So this ADR builds the production architecture + extension seams now, ships a working
zero-config default, and leaves the cloud network call as a clearly-labeled stub.

## Decision

1. **`speak()` contract.** `NlResolution` gains `speak: string` (audio-optimized phrasing,
   distinct from the visual `summary`); `IntentDef` gains `speak(intent)`. `resolveNlIntent`
   composes it centrally so resolve bodies stay effect-focused. Single source of truth — the
   Registry — now also drives spoken feedback. (`src/modules/codecanvas/services/canvas-nl-command.ts`)

2. **Pluggable provider port (ports & adapters).** `TtsProvider { speak, stop, isAvailable }`
   with `resolveTtsProvider(active, configs, deps)` as the factory — mirrors
   `resolveRunnerCommand` (ADR-0025). Adapters live in
   `src/modules/codecanvas/services/voice/`:
   - **browser** — `window.speechSynthesis`, zero key, the **default, on by default**.
   - **cloud** — OpenAI / ElevenLabs / custom; front-end wiring (request → play) is complete,
     routing synthesis through Rust so the API key never enters the renderer.
   Adding a provider = one adapter + one registry entry.

3. **BYOK provider registry (Rust).** `tts_providers.rs` mirrors `model_registry.rs`:
   `~/.lotus/tts-providers.json` (atomic write, **chmod 0600**), API keys **redacted to "***"**
   over IPC with a `"***"`-sentinel upsert that preserves the stored key. Built-in providers
   (browser/openai/elevenlabs) can be disabled/reconfigured but not deleted. Tauri commands:
   `tts_list_providers · tts_get_provider · tts_upsert_provider · tts_delete_provider ·
   tts_set_active_provider · tts_synthesize` (allow-listed in `main-app-commands.toml`).

4. **Cloud synthesis runs in Rust.** `tts_synthesize` loads the unredacted key and is meant to
   call the provider HTTP API (e.g. OpenAI `/v1/audio/speech` via `ureq::post`) → base64 audio.
   **It is a deliberate, labeled stub today** — until implemented it returns
   "…not implemented yet (BYOK)". This is the single seam to finish the feature; everything
   around it is done and tested.

5. **Wiring.** `useVoiceFeedback` resolves the active provider and exposes `speak(text)`, which
   `CanvasPage` passes to `CanvasNlCommandBar`; the bar speaks each batch's `speak` lines after
   applying effects. Settings → **Voice** tab (registry-backed, password key field with redaction
   preserve) lets the user pick/configure providers.

## Consequences

- Voice is now **additive**: an STT/STS adapter (PLAN §7) feeds the same Registry + speaks via
  the same channel — no core changes.
- Browser TTS gives real spoken feedback today with zero configuration.
- Finishing cloud TTS is a **Rust-only** change in `cmd_synthesize` (per `kind`); keys stay off
  the renderer by construction.
- Threat model for keys equals `model-registry.json` / `telegram-bot.json` (0600, redacted IPC).
