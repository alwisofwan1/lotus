/**
 * One-line Frame notices ("Maksimal 4 Frame", "Frame bertumpuk dengan Auth") raised by the Frame
 * operations, which live far from the toast. Module-level like canvasFrameDropStore: a refusal in
 * useCanvasFrameOps reaches the Frame toast without threading a callback through every create path.
 */
type Listener = (text: string) => void;
const listeners = new Set<Listener>();

export const canvasFrameNoticeStore = {
  show(text: string): void {
    for (const listener of listeners) listener(text);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
