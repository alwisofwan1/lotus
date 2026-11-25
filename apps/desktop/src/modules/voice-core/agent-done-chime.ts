/**
 * The "sound" Agent-Done Alert: a short chime, no words (Lotus #184). Needs no voice provider or key.
 *
 * Played natively (`playNative`, Rust `afplay`) when it can be: a seek+play on the webview's audio
 * element twice hung WebKit (WebContent blocked on the GPU process) and left every click dead until
 * the app was quit (2026-11-15). Otherwise through `HTMLAudioElement`, never Web Audio: in this app's
 * macOS WKWebView, `AudioContext.destination` output is unreliable or silent (CLAUDE.md).
 * Several agents finishing together play ONE chime — anything inside {@link CHIME_BATCH_MS} of the
 * last one is absorbed.
 */

export const AGENT_DONE_CHIME_SRC = "/sounds/agent-done.wav";
export const CHIME_BATCH_MS = 1500;

/**
 * The sounds Settings offers (mockups/agent-done-sounds.html). Bundled WAVs, so every platform gets
 * the same set; the synthesised ones come from `scripts/gen-agent-done-sounds.ts`. The id is what
 * `VoiceOutputSettings.agentDoneSound` stores — never rename one, a saved choice would fall back.
 */
export const AGENT_DONE_SOUNDS = [
  { id: "classic", label: "Classic", src: AGENT_DONE_CHIME_SRC },
  { id: "chime", label: "Chime", src: "/sounds/agent-done-chime.wav" },
  { id: "rise", label: "Rise", src: "/sounds/agent-done-rise.wav" },
  { id: "hollow", label: "Hollow", src: "/sounds/agent-done-hollow.wav" },
  { id: "droplet", label: "Droplet", src: "/sounds/agent-done-droplet.wav" },
  { id: "pickup", label: "Pickup", src: "/sounds/agent-done-pickup.wav" },
  { id: "notify1", label: "Notify", src: "/sounds/agent-done-notify1.wav" },
  { id: "notify2", label: "Notify Duo", src: "/sounds/agent-done-notify2.wav" },
] as const;

/** Played when Live Voice closes by itself (a sign-off or the time cap). One of the bundled sounds, so it plays natively. */
export const LIVE_VOICE_END_SOUND_SRC = "/sounds/agent-done-droplet.wav";

export type AgentDoneSoundId = (typeof AGENT_DONE_SOUNDS)[number]["id"];

/** The saved sound id as one Settings knows; absent or unknown (a file from a newer build) = Classic. */
export function agentDoneSoundId(saved: string | undefined): AgentDoneSoundId {
  return AGENT_DONE_SOUNDS.find((s) => s.id === saved)?.id ?? "classic";
}

export function agentDoneSoundSrc(saved: string | undefined): string {
  const id = agentDoneSoundId(saved);
  return AGENT_DONE_SOUNDS.find((s) => s.id === id)!.src;
}

export interface ChimePlayer {
  /** Play `src` (default: Classic), unless one played within the batch window. */
  play(src?: string): void;
}

interface ChimeAudio {
  play(): Promise<void> | void;
  volume: number;
  currentTime: number;
  src: string;
}

export interface ChimePlayerDeps {
  createAudio?: (src: string) => ChimeAudio;
  now?: () => number;
  src?: string;
  /** Window inside which a second play is absorbed. 0 for a Settings preview, which must always play. */
  batchMs?: number;
  /** Play a sound by id outside the webview; a rejection falls back to the audio element. */
  playNative?: (id: string) => Promise<void>;
}

export function createChimePlayer({
  createAudio = (src) => new Audio(src),
  now = Date.now,
  src: defaultSrc = AGENT_DONE_CHIME_SRC,
  batchMs = CHIME_BATCH_MS,
  playNative,
}: ChimePlayerDeps = {}): ChimePlayer {
  let lastAt = Number.NEGATIVE_INFINITY;
  // One element for the player's life. A fresh one per chime is never unloaded and stays
  // registered as a WebKit media session until GC; each session status update walks them all.
  let audio: ChimeAudio | null = null;
  // What we last assigned: `audio.src` reads back as an absolute URL, so it can't be compared.
  let loaded = "";
  const playElement = (src: string) => {
    try {
      if (!audio) audio = createAudio(src);
      else if (loaded !== src) audio.src = src;
      loaded = src;
      audio.volume = 0.6;
      // Rewind first: play() on an element that is still playing or has ended is a no-op.
      audio.currentTime = 0;
      void Promise.resolve(audio.play()).catch((error: unknown) =>
        console.warn("[voice] agent-done chime failed:", error),
      );
    } catch (error) {
      console.warn("[voice] agent-done chime failed:", error);
    }
  };
  return {
    play(src = defaultSrc) {
      const at = now();
      if (at - lastAt < batchMs) return;
      lastAt = at;
      const id = AGENT_DONE_SOUNDS.find((s) => s.src === src)?.id;
      if (playNative && id) void playNative(id).catch(() => playElement(src));
      else playElement(src);
    },
  };
}
