"use client";
import type { SttProvider } from "./stt-provider";

/**
 * Reliability wrapper (W4): try a primary STT provider (Deepgram realtime streaming) and, if it can't
 * establish its session at `start()` — a bad/absent key, a network hiccup, or a WebSocket that never
 * opens — transparently fall back to a batch provider so voice never dead-ends. The primary is torn
 * down first (releasing its mic) so the fallback's capture doesn't fight it for the device.
 *
 * Only connect-time failures trigger the fallback; a genuine mic-permission denial rejects from BOTH
 * providers and propagates (correct — that's not something batch can rescue). The fallback is built
 * lazily so the common happy path (streaming connects) never constructs it.
 */
export interface FallbackSttOptions {
  /** Notified once when the primary fails and we switch to the fallback — for a one-line log / metric. */
  onFallback?: (err: unknown) => void;
}

export function createFallbackSttProvider(
  primary: SttProvider,
  buildFallback: () => SttProvider,
  opts: FallbackSttOptions = {},
): SttProvider {
  let fallback: SttProvider | null = null;
  let active: SttProvider | null = null;
  const getFallback = () => (fallback ??= buildFallback());

  return {
    id: primary.id,
    kind: primary.kind,
    isAvailable: () => primary.isAvailable() || getFallback().isAvailable(),
    async start() {
      try {
        await primary.start();
        active = primary;
      } catch (err) {
        // Streaming couldn't connect — release whatever it half-acquired (e.g. the mic stream grabbed
        // before the socket failed) so the batch capture below gets a clean device, then retry on batch.
        try {
          primary.cancel();
        } catch {
          /* best-effort teardown */
        }
        opts.onFallback?.(err);
        const fb = getFallback();
        await fb.start(); // if batch ALSO fails (e.g. real permission denial), let it propagate.
        active = fb;
      }
    },
    async stop() {
      return active ? active.stop() : "";
    },
    cancel() {
      active?.cancel();
      active = null;
    },
  };
}
