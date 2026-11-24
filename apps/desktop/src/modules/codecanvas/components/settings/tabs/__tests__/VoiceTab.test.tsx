import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_OUTPUT } from "@/lib/tauri-api";

interface Row { id: string; name: string; kind: string; enabled: boolean; apiKey?: string; language?: string }
const reg = vi.hoisted(() => ({
  stt: null as null | { activeProvider: string; providers: Row[] },
  tts: null as null | { activeProvider: string; providers: Row[]; output: unknown },
  s2s: null as null | { activeProvider: string; providers: Row[] },
}));
const refresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/hooks/useSttProviderRegistry", () => ({ useSttProviderRegistry: () => ({ registry: reg.stt, loading: false, error: null, refresh }) }));
vi.mock("@/lib/hooks/useTtsProviderRegistry", () => ({ useTtsProviderRegistry: () => ({ registry: reg.tts, loading: false, error: null, refresh }) }));
vi.mock("@/lib/hooks/useS2sProviderRegistry", () => ({ useS2sProviderRegistry: () => ({ registry: reg.s2s, loading: false, error: null, refresh }) }));

const api = vi.hoisted(() => ({
  saveSttProviderConfig: vi.fn(async () => {}),
  setActiveSttProvider: vi.fn(async () => {}),
  saveTtsProviderConfig: vi.fn(async () => {}),
  setActiveTtsProvider: vi.fn(async () => {}),
  saveS2sProviderConfig: vi.fn(async () => {}),
  setActiveS2sProvider: vi.fn(async () => {}),
  setVoiceOutput: vi.fn(async () => {}),
  openExternalLink: vi.fn(async () => {}),
}));
vi.mock("@/lib/tauri-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

const voice = vi.hoisted(() => ({ preview: vi.fn(async () => {}), stopPreview: vi.fn() }));
vi.mock("@/modules/voice-core/use-voice-feedback", () => ({ useVoiceFeedback: () => voice }));

const stt = vi.hoisted(() => ({
  start: vi.fn(async () => true),
  stop: vi.fn(async () => "hello there"),
  cancel: vi.fn(),
}));
vi.mock("@/modules/voice-core/use-speech-to-text", () => ({
  useSpeechToText: () => ({ available: true, starting: false, recording: false, transcribing: false, interim: "", ...stt, getLastTurnMetadata: () => null }),
}));

vi.mock("../voice/ListenPanel", () => ({ ListenPanel: () => <div>listen drawer</div> }));
vi.mock("../voice/SpeakPanel", () => ({ SpeakPanel: () => <div>speak drawer</div> }));
vi.mock("../voice/LivePanel", () => ({ LivePanel: () => <div>live drawer</div> }));
vi.mock("../voice/VoiceBehaviourSection", () => ({ VoiceBehaviourSection: () => <div>How voice behaves</div> }));
vi.mock("../voice/VoiceAdvancedSection", () => ({
  VoiceAdvancedSection: ({ onRerunSetup }: { onRerunSetup: () => void }) => <button onClick={onRerunSetup}>Rerun setup</button>,
}));

import { MAC_MIC_PRIVACY_URL, VoiceTab } from "../VoiceTab";
import { resetVoiceSetupStoreForTests } from "../voice/voice-setup-store";

const browser = (id = "browser"): Row => ({ id, name: "Built-in", kind: "browser", enabled: true });
const openai = (apiKey?: string): Row => ({ id: "openai", name: "OpenAI", kind: "openai", enabled: true, apiKey });

function registries({ sttActive = "browser", ttsActive = "browser", sttKey, ttsKey }: { sttActive?: string; ttsActive?: string; sttKey?: string; ttsKey?: string } = {}) {
  reg.stt = { activeProvider: sttActive, providers: [browser(), openai(sttKey)] };
  reg.tts = { activeProvider: ttsActive, providers: [browser(), openai(ttsKey)], output: DEFAULT_VOICE_OUTPUT };
  reg.s2s = { activeProvider: "", providers: [{ id: "openai-realtime", name: "OpenAI Realtime", kind: "openai-realtime", enabled: false }] };
}

const card = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name} —`) });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetVoiceSetupStoreForTests();
  stt.start.mockResolvedValue(true);
  stt.stop.mockResolvedValue("hello there");
  voice.preview.mockResolvedValue(undefined);
});

describe("VoiceTab — first-time setup", () => {
  it("walks a new profile through engine, mic test and voice test, then shows the main screen", async () => {
    registries();
    render(<VoiceTab />);
    expect(screen.getByText("Pick an engine")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Test your mic");
    expect(api.setActiveSttProvider).toHaveBeenCalledWith("browser");

    fireEvent.click(screen.getByRole("button", { name: /Start mic test/ }));
    await waitFor(() => expect(stt.start).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /Stop/ }));
    expect(await screen.findByText("“hello there”")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: /Play/ }));
    await waitFor(() => expect(voice.preview).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /Yes/ }));

    expect(await screen.findByText("Listen")).toBeInTheDocument();
    expect(localStorage.getItem("lotus-voice-setup-v1")).toBe("done");
  });

  it("saves one OpenAI key to Listen and Speak and makes them active", async () => {
    registries();
    render(<VoiceTab />);
    fireEvent.click(screen.getByRole("radio", { name: /OpenAI/ }));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText("Test your mic");
    expect(api.saveSttProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ id: "openai", apiKey: "sk-test", enabled: true }));
    expect(api.saveTtsProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ id: "openai", apiKey: "sk-test", enabled: true }));
    expect(api.setActiveSttProvider).toHaveBeenCalledWith("openai");
    expect(api.setActiveTtsProvider).toHaveBeenCalledWith("openai");
    // Live gets the key but stays off.
    expect(api.saveS2sProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ id: "openai-realtime", apiKey: "sk-test" }));
    expect(api.setActiveS2sProvider).not.toHaveBeenCalled();
  });

  it("can be skipped, and rerun from Advanced", () => {
    registries();
    render(<VoiceTab />);
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(localStorage.getItem("lotus-voice-setup-v1")).toBe("skipped");
    expect(card("Listen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rerun setup" }));
    expect(screen.getByText("Pick an engine")).toBeInTheDocument();
  });
});

describe("VoiceTab — card states", () => {
  beforeEach(() => localStorage.setItem("lotus-voice-setup-v1", "done"));

  it("says a cloud engine needs a key and saves one inline", async () => {
    registries({ sttActive: "openai" });
    render(<VoiceTab />);
    const listen = card("Listen");
    expect(within(listen).getByText("Needs a key")).toBeInTheDocument();

    fireEvent.change(within(listen).getByLabelText("OpenAI API key"), { target: { value: "sk-new" } });
    fireEvent.click(within(listen).getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(api.saveSttProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ id: "openai", apiKey: "sk-new" })));
  });

  it("reads 'Key saved' until a test passes, never 'Ready' from a stored key alone", async () => {
    registries({ ttsActive: "openai", ttsKey: "***" });
    render(<VoiceTab />);
    expect(within(card("Speak")).getByText("Key saved")).toBeInTheDocument();

    fireEvent.click(within(card("Speak")).getByRole("button", { name: "Test" }));
    expect(await within(card("Speak")).findByText(/^tested just now/)).toBeInTheDocument();
    expect(card("Speak")).toHaveAccessibleName("Speak — Ready");
  });

  it("turns a refused key into Key refused with one fix", async () => {
    registries({ ttsActive: "openai", ttsKey: "***" });
    voice.preview.mockRejectedValueOnce(new Error("OpenAI speech failed (HTTP 401): Incorrect API key provided"));
    render(<VoiceTab />);
    fireEvent.click(within(card("Speak")).getByRole("button", { name: "Test" }));

    const speak = card("Speak");
    expect(await within(speak).findByText("Key refused")).toBeInTheDocument();
    fireEvent.click(within(speak).getByRole("button", { name: "Fix key" }));
    expect(within(speak).getByLabelText("OpenAI API key")).toBeInTheDocument();
  });

  it("offers Open Privacy when macOS blocks the mic", async () => {
    registries();
    stt.start.mockRejectedValueOnce(new Error("NotAllowedError: Permission denied"));
    render(<VoiceTab />);
    await act(async () => fireEvent.click(within(card("Listen")).getByRole("button", { name: "Test" })));

    const listen = card("Listen");
    expect(within(listen).getByText("macOS blocked the microphone")).toBeInTheDocument();
    fireEvent.click(within(listen).getByRole("button", { name: "Open Privacy" }));
    expect(api.openExternalLink).toHaveBeenCalledWith(MAC_MIC_PRIVACY_URL);
  });

  it("shows Live as Off with Set up, which opens its drawer", () => {
    registries();
    render(<VoiceTab />);
    const live = card("Live");
    expect(within(live).getByText("Off")).toBeInTheDocument();
    fireEvent.click(within(live).getByRole("button", { name: "Set up" }));
    expect(screen.getByText("live drawer")).toBeInTheDocument();
  });
});
