import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_OUTPUT, type VoiceOutputSettings } from "@/lib/tauri-api";
import {
  agentDoneAlertKind,
  agentDoneAlertMode,
  shouldAlertAgentFinish,
  withAgentDoneAlert,
} from "../agent-done-alert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DONE_SOUNDS, CHIME_BATCH_MS, agentDoneSoundId, agentDoneSoundSrc, createChimePlayer } from "../agent-done-chime";
import { createSpeakerQueue } from "../speaker-queue";

const out = (over: Partial<VoiceOutputSettings> = {}): VoiceOutputSettings => ({ ...DEFAULT_VOICE_OUTPUT, ...over });

describe("Agent-Done Alert mode", () => {
  it("defaults to Sound when no choice is saved: on = Sound, off = Off", () => {
    expect(agentDoneAlertMode(out({ agentDoneCallouts: true }))).toBe("sound");
    expect(agentDoneAlertMode(out({ agentDoneCallouts: false }))).toBe("off");
    expect(agentDoneAlertMode(undefined)).toBe("off");
  });

  it("prefers the saved mode, and ignores a value it does not know", () => {
    expect(agentDoneAlertMode(out({ agentDoneCallouts: false, agentDoneAlert: "sound" }))).toBe("sound");
    expect(agentDoneAlertMode(out({ agentDoneCallouts: true, agentDoneAlert: "beep" as never }))).toBe("sound");
  });

  it("keeps the old switch in step so an older build reads the same choice", () => {
    expect(withAgentDoneAlert(out(), "off")).toMatchObject({ agentDoneAlert: "off", agentDoneCallouts: false });
    expect(withAgentDoneAlert(out({ agentDoneCallouts: false }), "sound")).toMatchObject({ agentDoneAlert: "sound", agentDoneCallouts: true });
  });

  it("alerts for an unseen finish whenever not Off; a seen one only with 'Also when on screen'", () => {
    expect(shouldAlertAgentFinish(false, out({ agentDoneAlert: "sound" }))).toBe(true);
    expect(shouldAlertAgentFinish(true, out({ agentDoneAlert: "sound", wakeOnFinish: false }))).toBe(false);
    expect(shouldAlertAgentFinish(true, out({ agentDoneAlert: "voice", wakeOnFinish: true }))).toBe(true);
    expect(shouldAlertAgentFinish(true, out({ agentDoneAlert: "off", wakeOnFinish: true }))).toBe(false);
  });

  it("plays the chime for Sound, and for Voice when nothing can speak", () => {
    expect(agentDoneAlertKind(out({ agentDoneAlert: "voice" }), true)).toBe("voice");
    expect(agentDoneAlertKind(out({ agentDoneAlert: "voice" }), false)).toBe("sound");
    expect(agentDoneAlertKind(out({ agentDoneAlert: "sound" }), true)).toBe("sound");
    expect(agentDoneAlertKind(out({ agentDoneAlert: "off" }), true)).toBeNull();
  });
});

describe("agent-done chime", () => {
  it("plays through an audio element and folds a burst into one chime", () => {
    const clock = { t: 0 };
    const play = vi.fn(async () => {});
    const createAudio = vi.fn((src: string) => ({ play, volume: 1, currentTime: 0, src }));
    const chime = createChimePlayer({ createAudio, now: () => clock.t });

    chime.play();
    clock.t += 200;
    chime.play();
    expect(play).toHaveBeenCalledTimes(1);
    expect(createAudio).toHaveBeenCalledWith("/sounds/agent-done.wav");

    clock.t += CHIME_BATCH_MS;
    chime.play();
    expect(play).toHaveBeenCalledTimes(2);
    // One reused element, not one per chime (each would linger as a WebKit media session).
    expect(createAudio).toHaveBeenCalledOnce();
  });

  it("plays the picked sound on the same element, swapping its source only when the pick changes", () => {
    const clock = { t: 0 };
    const audio = { play: vi.fn(async () => {}), volume: 1, currentTime: 0, src: "" };
    const createAudio = vi.fn((src: string) => Object.assign(audio, { src }));
    const chime = createChimePlayer({ createAudio, now: () => clock.t });

    chime.play(agentDoneSoundSrc("droplet"));
    expect(audio.src).toBe("/sounds/agent-done-droplet.wav");
    clock.t += CHIME_BATCH_MS;
    audio.src = "http://localhost/sounds/agent-done-droplet.wav"; // what a real element reads back
    chime.play(agentDoneSoundSrc("droplet"));
    expect(audio.src).toBe("http://localhost/sounds/agent-done-droplet.wav"); // untouched: no reload
    clock.t += CHIME_BATCH_MS;
    chime.play(agentDoneSoundSrc("pickup"));

    expect(audio.src).toBe("/sounds/agent-done-pickup.wav");
    expect(audio.play).toHaveBeenCalledTimes(3);
    expect(createAudio).toHaveBeenCalledOnce();
  });

  it("plays natively by id, keeping the webview's audio element out of it", async () => {
    const createAudio = vi.fn();
    const playNative = vi.fn(() => Promise.resolve());
    createChimePlayer({ createAudio, playNative, now: () => 0 }).play(agentDoneSoundSrc("droplet"));
    await Promise.resolve();
    expect(playNative).toHaveBeenCalledWith("droplet");
    expect(createAudio).not.toHaveBeenCalled();
  });

  it("falls back to the audio element when native playback rejects", async () => {
    const play = vi.fn();
    const createAudio = vi.fn((src: string) => ({ play, volume: 1, currentTime: 0, src }));
    const playNative = vi.fn(() => Promise.reject(new Error("not macOS")));
    createChimePlayer({ createAudio, playNative, now: () => 0 }).play();
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(createAudio).toHaveBeenCalledWith("/sounds/agent-done.wav");
  });

  it("plays every preview when the batch window is 0", () => {
    const play = vi.fn(async () => {});
    const chime = createChimePlayer({ createAudio: (src) => ({ play, volume: 1, currentTime: 0, src }), now: () => 0, batchMs: 0 });
    chime.play();
    chime.play();
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("falls back to Classic for an absent or unknown saved sound", () => {
    expect(agentDoneSoundId(undefined)).toBe("classic");
    expect(agentDoneSoundId("from-a-newer-build")).toBe("classic");
    expect(agentDoneSoundSrc(undefined)).toBe("/sounds/agent-done.wav");
    expect(agentDoneSoundSrc("notify2")).toBe("/sounds/agent-done-notify2.wav");
  });

  it("ships a file for every sound Settings offers", () => {
    for (const s of AGENT_DONE_SOUNDS) expect(existsSync(join(process.cwd(), "public", s.src)), s.src).toBe(true);
  });

  it("never throws when the element cannot play", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chime = createChimePlayer({ createAudio: (src) => ({ play: () => Promise.reject(new Error("blocked")), volume: 1, currentTime: 0, src }) });
    expect(() => chime.play()).not.toThrow();
    await Promise.resolve();
    warn.mockRestore();
  });
});

describe("Speaker Queue hold state", () => {
  it("reports while Live Voice holds it, so the chime can stay quiet", () => {
    const queue = createSpeakerQueue({ play: async () => {} });
    expect(queue.isHeld()).toBe(false);
    queue.hold();
    expect(queue.isHeld()).toBe(true);
    queue.release();
    expect(queue.isHeld()).toBe(false);
  });
});
