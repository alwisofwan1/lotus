/**
 * The open-request seam between a File Node (which only LOOKS at a file) and the Canvas Dock's
 * Code app (which edits it).
 *
 *   openInCode({ path, line? })      ask Code to open `path` (absolute, `/`-separated, the same
 *                                    spelling the editor file index returns), optionally at `line`
 *                                    (1-based). Fire and forget; an empty path is ignored.
 *   subscribeOpenInCode(listener)    the Code app listens here; returns the unsubscribe.
 *
 * Pure and UI-free, on the same shape as `dock-factory-request.ts`: the node lives inside React
 * Flow, far from the Dock's state, so it asks here and the Dock answers. With no subscriber
 * (Code app not mounted or not built yet) a request is dropped, never queued.
 */
export interface OpenInCodeRequest {
  path: string;
  line?: number;
}

type Listener = (request: OpenInCodeRequest) => void;
const listeners = new Set<Listener>();

export function openInCode(request: OpenInCodeRequest): void {
  if (!request.path) return;
  listeners.forEach((listener) => listener(request));
}

export function subscribeOpenInCode(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
