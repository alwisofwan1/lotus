import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createPlayerBridge, type PlayerBridge } from "./youtube-player-bridge";

let iframe: HTMLIFrameElement;
let posted: Mock;
let bridge: PlayerBridge | null = null;

beforeEach(() => {
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  posted = vi.fn();
  vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(posted);
});

afterEach(() => {
  bridge?.destroy();
  bridge = null;
  iframe.remove();
  vi.restoreAllMocks();
});

/** Payloads the bridge posted to the player, JSON-decoded. */
function sentPayloads(): Array<Record<string, unknown>> {
  return posted.mock.calls.map(([data]) => JSON.parse(data as string));
}

function spyOnCurrentContentWindow() {
  vi.mocked(iframe.contentWindow!.postMessage).mockRestore?.();
  posted = vi.fn();
  vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(posted);
}

describe("createPlayerBridge", () => {
  it("posts a playVideo command on play()", () => {
    iframe.src = "https://www.youtube.com/embed/dQw4w9WgXcQ";
    spyOnCurrentContentWindow();
    bridge = createPlayerBridge(iframe, {});
    bridge.play();
    expect(sentPayloads()).toContainEqual(
      expect.objectContaining({ event: "command", func: "playVideo" }),
    );
    expect(posted).toHaveBeenLastCalledWith(expect.any(String), "https://www.youtube.com");
  });

  it("posts commands to the wrapper origin when the iframe is a local player wrapper", () => {
    iframe.src = "http://127.0.0.1:9877/api/music/youtube-player?videoId=dQw4w9WgXcQ";
    spyOnCurrentContentWindow();
    bridge = createPlayerBridge(iframe, {});
    bridge.play();
    expect(posted).toHaveBeenLastCalledWith(expect.any(String), "http://127.0.0.1:9877");
  });

  it("opens the info stream with a listening handshake on create and on iframe load", () => {
    bridge = createPlayerBridge(iframe, {});
    expect(sentPayloads().filter((p) => p.event === "listening")).toHaveLength(1);
    iframe.dispatchEvent(new Event("load"));
    expect(sentPayloads().filter((p) => p.event === "listening")).toHaveLength(2);
  });

  it("maps transport calls to widget commands with args", () => {
    bridge = createPlayerBridge(iframe, {});
    bridge.pause();
    bridge.seekTo(90);
    bridge.setVolume(250);
    const payloads = sentPayloads();
    expect(payloads).toContainEqual(expect.objectContaining({ func: "pauseVideo" }));
    expect(payloads).toContainEqual(expect.objectContaining({ func: "seekTo", args: [90, true] }));
    expect(payloads).toContainEqual(expect.objectContaining({ func: "setVolume", args: [100] }));
  });
});

/** Simulate a message coming FROM the player iframe. */
function playerMessage(data: unknown, source: Window | null = iframe.contentWindow) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: typeof data === "string" ? data : JSON.stringify(data),
      origin: "https://www.youtube.com",
      source,
    }),
  );
}

describe("player → bridge messages", () => {
  it("decodes infoDelivery into onTime and onState", () => {
    const onTime = vi.fn();
    const onState = vi.fn();
    bridge = createPlayerBridge(iframe, { onTime, onState });
    playerMessage({ event: "infoDelivery", info: { currentTime: 42.5, duration: 180, playerState: 1 } });
    expect(onTime).toHaveBeenCalledWith({ currentTime: 42.5, duration: 180 });
    expect(onState).toHaveBeenCalledWith("playing");
    playerMessage({ event: "infoDelivery", info: { playerState: 0 } });
    expect(onState).toHaveBeenLastCalledWith("ended");
    expect(onTime).toHaveBeenCalledTimes(1);
  });

  it("routes onError codes (150 = embed disallowed)", () => {
    const onError = vi.fn();
    bridge = createPlayerBridge(iframe, { onError });
    playerMessage({ event: "onError", info: "150" });
    expect(onError).toHaveBeenCalledWith(150);
  });

  it("routes onReady so environment probes can finish before playback starts", () => {
    const onReady = vi.fn();
    bridge = createPlayerBridge(iframe, { onReady });
    playerMessage({ event: "onReady" });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("forwards onReady once per load and onState only on change (no command feedback loop)", () => {
    const onReady = vi.fn();
    const onState = vi.fn();
    bridge = createPlayerBridge(iframe, { onReady, onState });
    // The player answers every setVolume/playVideo with another infoDelivery; repeats must not re-fire.
    for (let i = 0; i < 50; i += 1) playerMessage({ event: "infoDelivery", info: { playerState: 1, volume: 77 } });
    playerMessage({ event: "onReady" });
    expect(onReady).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledOnce();
    playerMessage({ event: "infoDelivery", info: { playerState: 2 } });
    playerMessage({ event: "infoDelivery", info: { playerState: 1 } });
    expect(onState.mock.calls.map(([s]) => s)).toEqual(["playing", "paused", "playing"]);
    // A new page (track change / reload) is a new player: ready and state start over.
    iframe.dispatchEvent(new Event("load"));
    playerMessage({ event: "infoDelivery", info: { playerState: 1 } });
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onState).toHaveBeenCalledTimes(4);
  });

  it("ignores messages from other windows and non-JSON payloads", () => {
    const onTime = vi.fn();
    bridge = createPlayerBridge(iframe, { onTime });
    playerMessage({ event: "infoDelivery", info: { currentTime: 1, duration: 2 } }, window);
    playerMessage("definitely not json");
    expect(onTime).not.toHaveBeenCalled();
  });

  it("goes inert after destroy()", () => {
    const onTime = vi.fn();
    bridge = createPlayerBridge(iframe, { onTime });
    bridge.destroy();
    playerMessage({ event: "infoDelivery", info: { currentTime: 1, duration: 2 } });
    expect(onTime).not.toHaveBeenCalled();
    bridge = null;
  });
});
