import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { TauriEvent, type EventCallback, type EventName, type UnlistenFn } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webview";

export type TauriUnlisten = () => void | Promise<void>;

const calledTauriUnlisteners = new WeakSet<TauriUnlisten>();

/**
 * Tauri listener cleanup is best-effort. The injected WebView listener registry
 * can race during React unmount/HMR and throw from user-script when an event id
 * was already removed (for example: `listeners[eventId].handlerId`). Cleanup
 * must never crash a CodeSpace surface.
 */
export function safeTauriUnlisten(unlisten: TauriUnlisten | null | undefined): void {
  if (!unlisten || calledTauriUnlisteners.has(unlisten)) return;
  calledTauriUnlisteners.add(unlisten);

  try {
    const result = unlisten();
    if (result && typeof result === "object" && "then" in result) {
      void Promise.resolve(result).catch(() => {
        // Best-effort cleanup only.
      });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

/** What `listenWebviewDragDrop` needs from a Webview: its `listen`. */
interface DragDropListenTarget {
  listen<T>(event: EventName, handler: EventCallback<T>): Promise<UnlistenFn>;
}

interface RawDragDropPayload {
  paths?: string[];
  position: { x: number; y: number };
}

/**
 * `Webview.onDragDropEvent`, with a cleanup that cannot crash.
 *
 * Tauri's own version (api 2.10) registers four listeners and returns
 * `() => { unlistenDragEnter(); unlistenDragDrop(); … }`. Each of those is an `async` function, so
 * the `listeners[eventId].handlerId` throw becomes a REJECTED promise that nobody awaits.
 * `safeTauriUnlisten` never sees it: its `try` wraps a function that returned `undefined`. It
 * surfaces as an unhandled rejection, which Next's dev overlay shows as a Runtime TypeError.
 *
 * So the four listens are made here, each released through `safeTauriUnlisten`, which catches
 * the rejection. The payloads match Tauri's mapping.
 */
export async function listenWebviewDragDrop(
  webview: DragDropListenTarget,
  handler: EventCallback<DragDropEvent>,
): Promise<TauriUnlisten> {
  const registered: TauriUnlisten[] = [];
  const release = () => {
    for (const unlisten of registered) safeTauriUnlisten(unlisten);
  };
  const on = async (event: EventName, toPayload: (payload: RawDragDropPayload) => DragDropEvent) => {
    registered.push(await webview.listen<RawDragDropPayload>(event, (raw) => handler({ ...raw, payload: toPayload(raw.payload) })));
  };
  try {
    await on(TauriEvent.DRAG_ENTER, (p) => ({ type: "enter", paths: p.paths ?? [], position: new PhysicalPosition(p.position) }));
    await on(TauriEvent.DRAG_OVER, (p) => ({ type: "over", position: new PhysicalPosition(p.position) }));
    await on(TauriEvent.DRAG_DROP, (p) => ({ type: "drop", paths: p.paths ?? [], position: new PhysicalPosition(p.position) }));
    await on(TauriEvent.DRAG_LEAVE, () => ({ type: "leave" }));
  } catch (error) {
    // A listen that fails part-way must not leave the earlier ones registered with no handle.
    release();
    throw error;
  }
  return release;
}
