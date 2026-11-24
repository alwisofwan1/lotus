export interface LiveAgentOutputScheduler {
  push(chunk: string): void;
  dispose(): void;
}

interface LiveAgentOutputSchedulerOptions {
  write: (batch: string) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (frameId: number) => void;
}

/**
 * Coalesces a burst of PTY chunks into at most one renderer write per animation
 * frame. PTY parsing and lifecycle remain immediate; only the expensive xterm
 * DOM paint is frame-bounded.
 */
export function createLiveAgentOutputScheduler({
  write,
  requestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame = (frameId) => window.cancelAnimationFrame(frameId),
}: LiveAgentOutputSchedulerOptions): LiveAgentOutputScheduler {
  let queuedChunks: string[] = [];
  let frameId: number | null = null;
  let disposed = false;

  const flush = () => {
    frameId = null;
    if (disposed || queuedChunks.length === 0) return;
    const batch = queuedChunks.join("");
    queuedChunks = [];
    write(batch);
  };

  return {
    push(chunk) {
      if (disposed || chunk.length === 0) return;
      queuedChunks.push(chunk);
      if (frameId === null) frameId = requestFrame(flush);
    },
    dispose() {
      disposed = true;
      queuedChunks = [];
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    },
  };
}
