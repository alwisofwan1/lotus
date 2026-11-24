// Canvas Browser Annotation Service
// Isolated store for annotation entries captured via the WebView overlay.
// Zero imports from src/modules/codespace/.

export interface CanvasBrowserAnnotationEntry {
  terminalId: string;
  payload: string;
  capturedAt: number;
  /** `native` means the Canvas-specific IPC command handled the payload; omitted for navigation fallback events. */
  source?: "native" | "navigation";
}

/** Module-level store: one annotation per terminalId (latest wins). */
const store = new Map<string, CanvasBrowserAnnotationEntry>();

/** Store or overwrite the latest annotation for a terminal. */
export function storeCanvasBrowserAnnotation(entry: CanvasBrowserAnnotationEntry): void {
  store.set(entry.terminalId, entry);
}

/** Return the most recent annotation for a terminal, or undefined. */
export function getLatestCanvasBrowserAnnotation(
  terminalId: string,
): CanvasBrowserAnnotationEntry | undefined {
  return store.get(terminalId);
}

/** Remove the annotation entry for a terminal. */
export function clearCanvasBrowserAnnotation(terminalId: string): void {
  store.delete(terminalId);
}
