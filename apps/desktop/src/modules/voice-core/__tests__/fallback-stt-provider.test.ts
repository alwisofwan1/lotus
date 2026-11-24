import { describe, expect, it, vi } from "vitest";
import { createFallbackSttProvider } from "../fallback-stt-provider";
import type { SttProvider } from "../stt-provider";

function stubProvider(over: Partial<SttProvider> & { id?: string }): SttProvider {
  return {
    id: over.id ?? "p",
    kind: "deepgram",
    isAvailable: over.isAvailable ?? (() => true),
    start: over.start ?? (async () => {}),
    stop: over.stop ?? (async () => ""),
    cancel: over.cancel ?? (() => {}),
  };
}

describe("createFallbackSttProvider", () => {
  it("uses the primary when it starts cleanly, and never builds the fallback", async () => {
    const primary = stubProvider({ start: vi.fn(async () => {}), stop: vi.fn(async () => "streamed") });
    const buildFallback = vi.fn(() => stubProvider({}));
    const p = createFallbackSttProvider(primary, buildFallback);

    await p.start();
    expect(await p.stop()).toBe("streamed");
    expect(buildFallback).not.toHaveBeenCalled();
  });

  it("falls back to batch when the primary fails to connect — voice still transcribes", async () => {
    const primary = stubProvider({
      start: vi.fn(async () => { throw new Error("ws connect failed"); }),
      cancel: vi.fn(),
      stop: vi.fn(async () => "should not be used"),
    });
    const batchStop = vi.fn(async () => "batched");
    const buildFallback = vi.fn(() => stubProvider({ id: "batch", stop: batchStop }));
    const onFallback = vi.fn();
    const p = createFallbackSttProvider(primary, buildFallback, { onFallback });

    await p.start();
    expect(primary.cancel).toHaveBeenCalled(); // release the streaming mic before batch grabs it
    expect(onFallback).toHaveBeenCalledOnce();
    expect(await p.stop()).toBe("batched");
    expect(batchStop).toHaveBeenCalled();
  });

  it("propagates when BOTH providers fail (e.g. a real mic-permission denial)", async () => {
    const primary = stubProvider({ start: async () => { throw new Error("denied"); }, cancel: vi.fn() });
    const buildFallback = () => stubProvider({ start: async () => { throw new Error("denied too"); } });
    const p = createFallbackSttProvider(primary, buildFallback);

    await expect(p.start()).rejects.toThrow(/denied too/);
  });

  it("reports available when either provider is available", () => {
    const primary = stubProvider({ isAvailable: () => false });
    const buildFallback = () => stubProvider({ isAvailable: () => true });
    expect(createFallbackSttProvider(primary, buildFallback).isAvailable()).toBe(true);
  });

  it("routes cancel to the active provider", async () => {
    const primaryCancel = vi.fn();
    const primary = stubProvider({ start: async () => {}, cancel: primaryCancel });
    const p = createFallbackSttProvider(primary, () => stubProvider({}));
    await p.start();
    p.cancel();
    expect(primaryCancel).toHaveBeenCalled();
  });
});
