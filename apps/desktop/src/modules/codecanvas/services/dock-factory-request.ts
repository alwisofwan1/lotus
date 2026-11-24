import type { FactoryRef } from "@/modules/factory";

/**
 * A Factory node asking the Canvas Dock to open its run (S3). The node lives inside React Flow,
 * far from the Dock's state, so it asks here and `useCanvasDock` answers — the canvas twin of
 * Factory's `requestOpenFactoryRun`, which the workspace shell answers by routing to `/`.
 */
type Request = { repo: string; issue: FactoryRef };
const listeners = new Set<(request: Request) => void>();

export function requestDockFactoryRun(request: Request): void {
  listeners.forEach((listener) => listener(request));
}

export function onDockFactoryRunRequest(listener: (request: Request) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
