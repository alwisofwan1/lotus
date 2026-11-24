export interface CanvasBrowserPairIdentity {
  /** ReactFlow BrowserNode id, used for canvas records and UI actions. */
  browserNodeId: string;
  /** ReactFlow TerminalNode id when the browser is owned by a terminal. */
  parentTerminalId: string | null;
  /** Stable Tauri WebView identity used by native browser commands and annotations. */
  nativeBrowserId: string;
}

export function resolveCanvasBrowserPairIdentity(
  browserNodeId: string,
  parentTerminalId: string | null | undefined,
): CanvasBrowserPairIdentity {
  return {
    browserNodeId,
    parentTerminalId: parentTerminalId ?? null,
    nativeBrowserId: parentTerminalId ?? browserNodeId,
  };
}
