"use client";
import { useState, type RefObject } from "react";
import { Check, Cpu, KeyRound, Mic, Play, Shuffle, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import type { ListenTest, SpeakTest } from "./useVoiceCardTests";
import type { VoiceStatus } from "./voice-health";

export type VoiceSetupChoice = "builtin" | "openai" | "mix";

interface Props {
  /** Applies step 1. Rejects with a message the step shows. */
  onPickEngine: (choice: VoiceSetupChoice, key?: string) => Promise<void>;
  listen: ListenTest;
  listenStatus: VoiceStatus;
  meterRef: RefObject<HTMLSpanElement | null>;
  speak: SpeakTest;
  speakStatus: VoiceStatus;
  /** The line step 3 plays. */
  sample: string;
  onPlaySample: () => void;
  onUseBuiltInVoice: () => Promise<void>;
  onFinish: () => void;
  onSkip: () => void;
}

const CHOICES: { id: VoiceSetupChoice; icon: typeof Cpu; title: string; body: string }[] = [
  { id: "builtin", icon: Cpu, title: "Built-in", body: "No key, works offline. Recognition is less reliable in the desktop app." },
  { id: "openai", icon: KeyRound, title: "OpenAI — one key", body: "One key for listening and speaking. Clear voices; Live can use it too." },
  { id: "mix", icon: Shuffle, title: "Mix", body: "Pick a different engine for Listen and Speak yourself." },
];

const WELL = "rounded-(--ui-r-md) bg-(--ui-fill) px-3 py-2.5 ds-t-meta text-(--ui-ink)";

/**
 * First-time Voice setup (mockups/settings-voice.html, frame 05): pick an engine, test the
 * mic, test the voice. Every step can be skipped; Live is not part of setup; Built-in still runs
 * both tests, because a webview mic can be blocked whatever the engine.
 */
export function VoiceSetupWizard(props: Props) {
  const { listen, speak } = props;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [choice, setChoice] = useState<VoiceSetupChoice>("builtin");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heard, setHeard] = useState<"yes" | "no" | null>(null);
  const [played, setPlayed] = useState(false);

  const pick = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onPickEngine(choice, choice === "openai" ? key.trim() : undefined);
      if (choice !== "mix") setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const listening = listen.phase === "listening";
  const listenFailed = props.listenStatus.tone === "err";
  const speakFailed = props.speakStatus.tone === "err";

  return (
    <section aria-label="Voice setup" className="ui-group-card">
      <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block ds-t-meta font-medium text-(--ui-ink-3)">Set up voice · Step {step} of 3</span>
          <span className="mt-0.5 block ds-t-body font-semibold text-(--ui-ink)">
            {step === 1 ? "Pick an engine" : step === 2 ? "Test your mic" : "Test the voice"}
          </span>
        </span>
        <span className="flex gap-1" aria-hidden="true">
          {[1, 2, 3].map((n) => (
            <span key={n} className="h-1 w-6 rounded-full" style={{ background: n <= step ? "var(--ui-accent)" : "var(--ui-line-strong)" }} />
          ))}
        </span>
      </header>

      {step === 1 && (
        <div className="flex flex-col gap-3">
          <div role="radiogroup" aria-label="Voice engine" className="grid grid-cols-3 gap-2">
            {CHOICES.map((c) => {
              const selected = choice === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setChoice(c.id)}
                  className="flex flex-col gap-1.5 rounded-(--ui-r-md) px-3 py-2.5 text-left transition-[background-color,box-shadow]"
                  style={{
                    boxShadow: selected ? "inset 0 0 0 1.5px var(--ui-accent)" : "inset 0 0 0 1px var(--ui-line-strong)",
                    background: selected ? "color-mix(in oklab, var(--ui-accent) 7%, transparent)" : "transparent",
                  }}
                >
                  <c.icon className="h-4 w-4" style={{ color: selected ? "var(--ui-accent)" : "var(--ui-ink-3)" }} aria-hidden="true" />
                  <span className="ds-t-body font-medium text-(--ui-ink)">{c.title}</span>
                  <span className="ds-t-meta leading-snug text-(--ui-ink-3)">{c.body}</span>
                </button>
              );
            })}
          </div>
          {choice === "openai" && (
            <Input
              mono
              type="password"
              aria-label="OpenAI API key"
              placeholder="sk-…  stored in ~/.lotus, never leaves your machine"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
          )}
          {error && <p role="alert" className="m-0 ds-t-meta text-(--ui-err)">{error}</p>}
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-2.5">
          <p className="m-0 ds-t-meta text-(--ui-ink-3)">Press Start and say a short sentence. It stops by itself after a few seconds.</p>
          <div className="h-1.5 overflow-hidden rounded-full bg-(--ui-fill)" aria-hidden="true">
            <span ref={props.meterRef} className="block h-full w-full origin-left rounded-full bg-(--ui-accent) transition-transform duration-75" style={{ transform: "scaleX(0)" }} />
          </div>
          <div className={`min-h-9 ${WELL}`} aria-live="polite">
            {listening ? listen.interim || "Listening…" : listen.phase === "transcribing" ? "Transcribing…" : listen.transcript ? `“${listen.transcript}”` : <span className="text-(--ui-ink-4)">Your words appear here.</span>}
          </div>
          {listen.ms !== null && listen.transcript && (
            <p className="m-0 ds-t-micro text-(--ui-ink-4)">Text arrived {(listen.ms / 1000).toFixed(1)} s after you stopped.</p>
          )}
          {listenFailed && <p role="alert" className="m-0 ds-t-meta text-(--ui-err)">{props.listenStatus.what} — {props.listenStatus.why}</p>}
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-2.5">
          <p className={`m-0 italic ${WELL}`}>“{props.sample}”</p>
          {played && !speak.playing && heard === null && !speakFailed && (
            <div className="flex items-center gap-2">
              <span className="flex-1 ds-t-meta text-(--ui-ink)">Did you hear it?</span>
              <Button variant="primary" size="sm" onClick={() => { setHeard("yes"); props.onFinish(); }}>
                <Check size={13} aria-hidden="true" /> Yes
              </Button>
              <Button size="sm" onClick={() => setHeard("no")}>No sound</Button>
            </div>
          )}
          {(heard === "no" || speakFailed) && (
            <div role="alert" className="flex flex-col items-start gap-2 rounded-(--ui-r-md) bg-[color-mix(in_oklab,var(--ui-warn)_10%,transparent)] px-3 py-2.5">
              <span className="ds-t-meta text-(--ui-ink)">
                {speakFailed ? `${props.speakStatus.what} — ${props.speakStatus.why}` : "Check the Mac's volume and output device, then play it again."}
              </span>
              <Button size="sm" onClick={() => { setHeard(null); void props.onUseBuiltInVoice(); }}>
                Use the built-in voice instead
              </Button>
            </div>
          )}
        </div>
      )}

      <footer className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={props.onSkip}>
          Skip setup
        </Button>
        <span className="flex-1" />
        {step === 1 && (
          <Button variant="primary" size="sm" disabled={busy || (choice === "openai" && !key.trim())} onClick={() => void pick()}>
            {busy ? "Saving…" : choice === "mix" ? "Choose engines" : "Continue"}
          </Button>
        )}
        {step === 2 && (
          <>
            {listening ? (
              <Button size="sm" onClick={() => void listen.stop()}>
                <Square size={13} aria-hidden="true" /> Stop
              </Button>
            ) : (
              <Button size="sm" disabled={listen.phase !== "idle"} onClick={() => void listen.start()}>
                <Mic size={13} aria-hidden="true" /> {listen.transcript || listenFailed ? "Test again" : "Start mic test"}
              </Button>
            )}
            <Button variant="primary" size="sm" disabled={listen.phase !== "idle"} onClick={() => setStep(3)}>
              Next
            </Button>
          </>
        )}
        {step === 3 && (
          <>
            {speak.playing ? (
              <Button size="sm" onClick={speak.stop}>
                <Square size={13} aria-hidden="true" /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={() => { setPlayed(true); setHeard(null); props.onPlaySample(); }}>
                {played ? <Volume2 size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />} {played ? "Play again" : "Play"}
              </Button>
            )}
            <Button variant="primary" size="sm" disabled={speak.playing} onClick={props.onFinish}>
              Finish
            </Button>
          </>
        )}
      </footer>
      </div>
    </section>
  );
}
