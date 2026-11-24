"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Square } from "lucide-react";
import { useTtsProviderRegistry } from "@/lib/hooks/useTtsProviderRegistry";
import { useSttProviderRegistry } from "@/lib/hooks/useSttProviderRegistry";
import { useS2sProviderRegistry } from "@/lib/hooks/useS2sProviderRegistry";
import {
  saveTtsProviderConfig,
  setActiveTtsProvider,
  saveSttProviderConfig,
  setActiveSttProvider,
  saveS2sProviderConfig,
  setActiveS2sProvider,
  setVoiceOutput,
  openExternalLink,
  DEFAULT_VOICE_OUTPUT,
  type TtsProviderConfig,
  type SttProviderConfig,
  type S2sProviderConfig,
} from "@/lib/tauri-api";
import { summarizeActiveEngine } from "@/modules/codecanvas/services/voice/engine-summary";
import { useVoiceFeedback } from "@/modules/voice-core/use-voice-feedback";
import { detectSpeechLanguage } from "@/modules/codecanvas/services/voice/speak-composer";
import type { VoiceProviderRow } from "./VoiceProviderList";
import { ListenPanel } from "./voice/ListenPanel";
import { SpeakPanel } from "./voice/SpeakPanel";
import { LivePanel } from "./voice/LivePanel";
import { VoiceBehaviourSection } from "./voice/VoiceBehaviourSection";
import { VoiceAdvancedSection } from "./voice/VoiceAdvancedSection";
import { CardButton, VoiceCapabilityCard, VoiceKeyFix } from "./voice/VoiceCapabilityCard";
import { SettingsSection } from "@/modules/lotus-settings/components/SettingsSection";
import { VoiceSetupWizard, type VoiceSetupChoice } from "./voice/VoiceSetupWizard";
import { useListenTest, useSpeakTest } from "./voice/useVoiceCardTests";
import { describeLastTest, voiceCapabilityStatus, type VoiceCapability, type VoiceStatus } from "./voice/voice-health";
import { clearVoiceTest, setVoiceSetupState, useVoiceSetupStore } from "./voice/voice-setup-store";
import { useVoiceHotkeyLabels } from "./voice/voice-shortcuts";

/** Curated OpenAI TTS voices (gpt-4o-mini-tts / tts-1). A stored value outside this list is still
 *  preserved by the dropdown, so it's safe to extend as OpenAI ships more. */
const OPENAI_TTS_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "marin", "cedar", "nova", "onyx", "sage", "shimmer", "verse",
] as const;

/** System Settings › Privacy › Microphone; the one non-web link `open_external_link` accepts. */
export const MAC_MIC_PRIVACY_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

const isBuiltIn = (kind: string | undefined) => kind === undefined || kind === "browser";

/**
 * Lotus Settings › Voice (mockups/settings-voice.html). Three engine rows — Listen, Speak, Live — whose lights come
 * from real checks, whose Test runs the real path and whose settings open under the row; then the behaviour groups and a
 * collapsed Advanced. A new profile gets a three-step setup first. Persistence is unchanged: the three provider registries and the TTS `output` block.
 */
export function VoiceTab() {
  const stt = useSttProviderRegistry();
  const tts = useTtsProviderRegistry();
  const s2s = useS2sProviderRegistry();
  const voice = useVoiceFeedback();
  const { setup, tests } = useVoiceSetupStore();
  const keys = useVoiceHotkeyLabels();
  const [drawer, setDrawer] = useState<VoiceCapability | null>(null);
  const [rerun, setRerun] = useState(false);
  const [wizardStarted, setWizardStarted] = useState(false);
  const [keyFix, setKeyFix] = useState<VoiceCapability | null>(null);
  const [pendingTest, setPendingTest] = useState<VoiceCapability | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const meterRef = useRef<HTMLSpanElement | null>(null);

  const sttSummary = summarizeActiveEngine(stt.registry ?? null);
  const ttsSummary = summarizeActiveEngine(tts.registry ?? null);
  const s2sSummary = summarizeActiveEngine(s2s.registry ?? null);
  const activeStt = stt.registry?.providers.find((p) => p.id === stt.registry?.activeProvider);
  const activeTts = tts.registry?.providers.find((p) => p.id === tts.registry?.activeProvider);
  const output = tts.registry?.output ?? DEFAULT_VOICE_OUTPUT;

  const showLevel = useCallback((level: number) => {
    if (meterRef.current) meterRef.current.style.transform = `scaleX(${level})`;
  }, []);
  const listenTest = useListenTest(sttSummary?.id ?? null, showLevel);
  const speakTest = useSpeakTest(voice, ttsSummary?.id ?? null);

  // "2 min ago" stays roughly true while the tab is open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const listenStatus = voiceCapabilityStatus({ capability: "listen", summary: sttSummary, lastTest: tests.listen, testing: listenTest.phase !== "idle" });
  const speakStatus = voiceCapabilityStatus({ capability: "speak", summary: ttsSummary, lastTest: tests.speak, testing: speakTest.playing });
  const liveStatus = voiceCapabilityStatus({ capability: "live", summary: s2sSummary });

  // The reply language decides the sample: English or Japanese (Indonesian is not a reply language).
  const replyLang = detectSpeechLanguage("", activeStt?.language);
  const sample =
    replyLang === "ja" ? "こんにちは。コマンドを確認するときは、このような声になります。" : "Hi! This is how I'll sound when confirming your commands.";
  const runSpeakTest = () => void speakTest.run(sample, replyLang);

  // "Save and test" waits for the saved key to show up in the registry before testing.
  useEffect(() => {
    if (pendingTest === "listen" && sttSummary?.hasKey) {
      setPendingTest(null);
      void listenTest.start();
    } else if (pendingTest === "speak" && ttsSummary?.hasKey) {
      setPendingTest(null);
      runSpeakTest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once when the key lands
  }, [pendingTest, sttSummary?.hasKey, ttsSummary?.hasKey]);

  const reload = () => {
    void stt.refresh();
    void tts.refresh();
    void s2s.refresh();
  };
  const changeOutput = async (next: typeof output) => {
    await setVoiceOutput(next);
    await tts.refresh();
  };

  const saveKey = async (capability: "listen" | "speak", apiKey: string) => {
    if (capability === "listen") {
      if (!activeStt) throw new Error("No engine to save the key to.");
      await saveSttProviderConfig({ ...activeStt, apiKey, enabled: true });
      await stt.refresh();
    } else {
      if (!activeTts) throw new Error("No engine to save the key to.");
      await saveTtsProviderConfig({ ...activeTts, apiKey, enabled: true });
      await tts.refresh();
    }
    clearVoiceTest(capability);
    setKeyFix(null);
    setPendingTest(capability);
  };

  const pickEngine = async (choice: VoiceSetupChoice, apiKey?: string) => {
    setWizardStarted(true);
    if (choice === "mix") {
      setVoiceSetupState("done");
      setRerun(false);
      setDrawer("listen");
      return;
    }
    if (choice === "builtin") {
      await setActiveSttProvider("browser");
      await setActiveTtsProvider("browser");
    } else {
      if (!apiKey) throw new Error("Paste your OpenAI key first.");
      const sttRow = stt.registry?.providers.find((p) => p.id === "openai");
      const ttsRow = tts.registry?.providers.find((p) => p.id === "openai");
      if (!sttRow || !ttsRow) throw new Error("OpenAI isn't in the engine list yet. Press Reload in Advanced and try again.");
      await saveSttProviderConfig({ ...sttRow, apiKey, enabled: true });
      await setActiveSttProvider("openai");
      await saveTtsProviderConfig({ ...ttsRow, apiKey, enabled: true });
      await setActiveTtsProvider("openai");
      // Live can use the same key later; it stays off until the user turns it on.
      const liveRow = s2s.registry?.providers.find((p) => p.id === "openai-realtime");
      if (liveRow && !liveRow.apiKey) await saveS2sProviderConfig({ ...liveRow, apiKey });
    }
    clearVoiceTest("listen");
    clearVoiceTest("speak");
    await Promise.all([stt.refresh(), tts.refresh(), s2s.refresh()]);
  };

  const closeWizard = (state: "done" | "skipped") => {
    listenTest.cancel();
    speakTest.stop();
    setVoiceSetupState(state);
    setRerun(false);
    setWizardStarted(false);
  };

  const loaded = Boolean(stt.registry && tts.registry && s2s.registry);
  const fresh = setup === null && isBuiltIn(sttSummary?.kind) && isBuiltIn(ttsSummary?.kind) && !s2sSummary?.ready;
  if (rerun || wizardStarted || (loaded && fresh)) {
    return (
      <VoiceSetupWizard
        onPickEngine={pickEngine}
        listen={listenTest}
        listenStatus={listenStatus}
        meterRef={meterRef}
        speak={speakTest}
        speakStatus={speakStatus}
        sample={sample}
        onPlaySample={runSpeakTest}
        onUseBuiltInVoice={async () => {
          await setActiveTtsProvider("browser");
          clearVoiceTest("speak");
          await tts.refresh();
        }}
        onFinish={() => closeWizard("done")}
        onSkip={() => closeWizard("skipped")}
      />
    );
  }

  const withClear = <T,>(capability: VoiceCapability, fn: (arg: T) => Promise<void>) => async (arg: T) => {
    await fn(arg);
    clearVoiceTest(capability);
  };

  const sttList = {
    heading: "Speech-to-text engine",
    loading: stt.loading,
    error: stt.error,
    providers: (stt.registry?.providers ?? []) as VoiceProviderRow[],
    active: stt.registry?.activeProvider ?? "browser",
    onSave: withClear("listen", async (p: VoiceProviderRow) => { await saveSttProviderConfig(p as unknown as SttProviderConfig); await stt.refresh(); }),
    onSetActive: withClear("listen", async (id: string) => { await setActiveSttProvider(id); await stt.refresh(); }),
    extraField: { key: "language", label: "Language (optional)", placeholder: "e.g. en, id" },
  };

  const ttsList = {
    heading: "Text-to-speech engine",
    loading: tts.loading,
    error: tts.error,
    providers: (tts.registry?.providers ?? []) as VoiceProviderRow[],
    active: tts.registry?.activeProvider ?? "browser",
    onSave: withClear("speak", async (p: VoiceProviderRow) => { await saveTtsProviderConfig(p as unknown as TtsProviderConfig); await tts.refresh(); }),
    onSetActive: withClear("speak", async (id: string) => { await setActiveTtsProvider(id); await tts.refresh(); }),
    extraField: {
      key: "voice",
      label: "Voice (optional)",
      placeholder: "e.g. voice id",
      // OpenAI exposes a known voice set → dropdown; ElevenLabs/custom use opaque ids → free-text.
      options: (row: VoiceProviderRow) => (row.kind === "openai" ? OPENAI_TTS_VOICES : undefined),
    },
  };

  const s2sList = {
    heading: "Voice-to-voice engine",
    loading: s2s.loading,
    error: s2s.error,
    providers: (s2s.registry?.providers ?? []) as VoiceProviderRow[],
    active: s2s.registry?.activeProvider ?? "",
    onSave: async (p: VoiceProviderRow) => { await saveS2sProviderConfig(p as unknown as S2sProviderConfig); await s2s.refresh(); },
    onSetActive: async (id: string) => { await setActiveS2sProvider(id); await s2s.refresh(); },
    extraField: { key: "voice", label: "Voice (optional)", placeholder: "e.g. voice id" },
  };

  const toggleDrawer = (capability: VoiceCapability) => setDrawer((d) => (d === capability ? null : capability));

  /** The one fix a card offers for its problem (frame 06). */
  const fixFor = (capability: "listen" | "speak", status: VoiceStatus, engine: string, hasEngine: boolean, retest: () => void): ReactNode => {
    if (!status.problem) return null;
    if (!hasEngine) return <CardButton onClick={() => setDrawer(capability)}>Choose engine</CardButton>;
    if (status.problem === "needs-key" || keyFix === capability) {
      return <VoiceKeyFix engine={engine} onSave={(k) => saveKey(capability, k)} />;
    }
    if (status.problem === "key-refused") return <CardButton primary onClick={() => setKeyFix(capability)}>Fix key</CardButton>;
    if (status.problem === "mic-blocked") return <CardButton primary onClick={() => void openExternalLink(MAC_MIC_PRIVACY_URL)}>Open Privacy</CardButton>;
    return <CardButton onClick={retest}>Test again</CardButton>;
  };

  const listening = listenTest.phase !== "idle";
  const liveOn = Boolean(s2sSummary?.ready);
  const ttsName = activeTts?.voice ? `${activeTts.name} · ${activeTts.voice}` : (ttsSummary?.name ?? "No voice");
  const testedHint = (test: typeof tests.listen, engineId: string | undefined) =>
    test && test.ok && test.engineId === engineId ? `tested ${describeLastTest(test, now)}` : undefined;

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection label="Engines">
        <VoiceCapabilityCard
          title="Listen"
          status={listenStatus}
          engine={sttSummary?.name ?? ""}
          hint={testedHint(tests.listen, sttSummary?.id)}
          fix={fixFor("listen", listenStatus, sttSummary?.name ?? "", Boolean(sttSummary), () => void listenTest.start())}
          open={drawer === "listen"}
          onToggle={() => toggleDrawer("listen")}
          actions={
            listening ? (
              <CardButton primary disabled={listenTest.phase !== "listening"} onClick={() => void listenTest.stop()}>
                <Square size={12} aria-hidden="true" />{listenTest.phase === "listening" ? "Stop" : "Transcribing…"}
              </CardButton>
            ) : (
              <CardButton onClick={() => void listenTest.start()} disabled={!sttSummary}>Test</CardButton>
            )
          }
          panel={<ListenPanel list={sttList} />}
        >
          {(listening || listenTest.transcript) && (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <span className="truncate ds-t-meta text-(--ui-ink)">
                {listenTest.phase === "listening" ? listenTest.interim || "Listening… say a short sentence" : listenTest.phase === "transcribing" ? "Transcribing…" : `“${listenTest.transcript}”`}
              </span>
              <div className="h-1 overflow-hidden rounded-full bg-(--ui-fill)" aria-hidden="true">
                <span ref={meterRef} className="block h-full w-full origin-left rounded-full bg-(--ui-accent) transition-transform duration-75" style={{ transform: "scaleX(0)" }} />
              </div>
            </div>
          )}
        </VoiceCapabilityCard>

        <VoiceCapabilityCard
          title="Speak"
          status={speakStatus}
          engine={ttsSummary ? ttsName : ""}
          hint={testedHint(tests.speak, ttsSummary?.id)}
          fix={fixFor("speak", speakStatus, ttsSummary?.name ?? "", Boolean(ttsSummary), runSpeakTest)}
          open={drawer === "speak"}
          onToggle={() => toggleDrawer("speak")}
          actions={
            speakTest.playing ? (
              <CardButton primary onClick={speakTest.stop}>
                <Square size={12} aria-hidden="true" />Stop
              </CardButton>
            ) : (
              <CardButton onClick={runSpeakTest} disabled={!ttsSummary}>Test</CardButton>
            )
          }
          panel={
            <SpeakPanel
              list={ttsList}
              output={output}
              onOutputChange={changeOutput}
              speed={activeTts?.speed}
              onSpeedChange={async (speed) => {
                if (!activeTts) return;
                // The redacted "***" key sentinel is preserved server-side (upsert keeps the stored key).
                await saveTtsProviderConfig({ ...activeTts, speed });
                await tts.refresh();
              }}
              disabled={tts.loading}
            />
          }
        />

        <VoiceCapabilityCard
          title="Live"
          note="optional"
          status={liveStatus}
          engine={liveOn ? (s2sSummary?.name ?? "") : ""}
          hint={liveOn ? `start with ${keys["live-voice"]}` : undefined}
          open={drawer === "live"}
          onToggle={() => toggleDrawer("live")}
          actions={liveOn ? undefined : <CardButton primary onClick={() => setDrawer("live")}>Set up</CardButton>}
          panel={<LivePanel list={s2sList} />}
        />
      </SettingsSection>

      <VoiceBehaviourSection output={output} onOutputChange={changeOutput} disabled={tts.loading} />

      <VoiceAdvancedSection onReload={reload} onRerunSetup={() => { setDrawer(null); setRerun(true); }} />
    </div>
  );
}
