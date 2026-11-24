import type { Node } from "@xyflow/react";
import { resolveCanvasBrowserPairIdentity } from "./canvas-browser-pair";
import { CANVAS_BROWSER_PARKED_BOUNDS } from "./viewport/canvas-viewport-policy";
import { syncCanvasBrowserBounds, closeCanvasBrowser } from "@/lib/tauri/canvas-browser";

/**
 * Native WebView ids for every browser node in a graph — the set to tear down when the owning
 * project stops being active. A browser node's native id is its parent terminal's id when paired,
 * else its own id (see resolveCanvasBrowserPairIdentity).
 */
export function collectCanvasBrowserTeardownIds(
  nodes: Pick<Node, "id" | "type" | "data">[],
): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "browser") continue;
    const parentTerminalId = (node.data as { parentTerminalId?: string } | undefined)?.parentTerminalId ?? null;
    ids.add(resolveCanvasBrowserPairIdentity(node.id, parentTerminalId).nativeBrowserId);
  }
  return [...ids];
}

export interface CanvasBrowserTeardownIpc {
  park: (nativeBrowserId: string) => Promise<unknown>;
  close: (nativeBrowserId: string) => Promise<unknown>;
}

const defaultIpc: CanvasBrowserTeardownIpc = {
  park: (id) => syncCanvasBrowserBounds(id, { ...CANVAS_BROWSER_PARKED_BOUNDS }),
  close: (id) => closeCanvasBrowser(id),
};

/**
 * Park each browser WebView off-screen (instant hide) then close it — done BEFORE the next project
 * hydrates, so a still-live page (whose native WebView is a window-level child, not scoped to the
 * canvas) never paints over the incoming project. Best-effort: a failing park/close for one id
 * never blocks the others.
 */
export async function teardownCanvasBrowsers(
  nativeBrowserIds: string[],
  ipc: CanvasBrowserTeardownIpc = defaultIpc,
): Promise<void> {
  await Promise.all(
    nativeBrowserIds.map(async (id) => {
      try { await ipc.park(id); } catch { /* keep going — closing still hides it */ }
      try { await ipc.close(id); } catch { /* best-effort teardown */ }
    }),
  );
}
