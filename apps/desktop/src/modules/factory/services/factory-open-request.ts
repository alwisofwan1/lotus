/**
 * "Open this run in the Factory", from a host that does not hold the Factory panel (#146).
 *
 * The canvas is another route than the workspace shell. The shell usually stays mounted across it
 * and hears the request at once; when the app opened straight onto the canvas it mounts only on
 * the way back, so a request nobody heard is kept and handed to the first listener. The request
 * names the issue, not the run, as every other Open in Factory does.
 */
import type { FactoryRef } from "./factory-run";

export interface FactoryOpenRequest {
  repo: string;
  issue: FactoryRef;
}

const listeners = new Set<(request: FactoryOpenRequest) => void>();
let unheard: FactoryOpenRequest | null = null;

export function requestOpenFactoryRun(request: FactoryOpenRequest): void {
  if (listeners.size === 0) {
    unheard = request;
    return;
  }
  listeners.forEach((listener) => listener(request));
}

export function onOpenFactoryRunRequest(handler: (request: FactoryOpenRequest) => void): () => void {
  listeners.add(handler);
  if (unheard) {
    const request = unheard;
    unheard = null;
    handler(request);
  }
  return () => {
    listeners.delete(handler);
  };
}
