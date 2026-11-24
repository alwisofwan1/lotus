import { listen } from "@tauri-apps/api/event";
import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/** One debounced batch of changes under an Editor pane's folder (`editor_watcher.rs`). */
export type EditorFsChange = {
  /** Which watch this batch is from; each call to `watchEditorRoot` has its own. */
  watchId: string;
  /** Absolute, `/`-separated. Empty when `overflow`. */
  paths: string[];
  /** The repo's index or HEAD moved. */
  git: boolean;
  /** Too many to list: read everything open or listed again. */
  overflow: boolean;
};

let watchSeq = 0;

/**
 * Watches `root` for this pane until the returned stop is called, handing each batch to
 * `onChange`. Local folders only; outside Tauri it does nothing.
 *
 * Every call gets its own watch id: Tauri commands are not ordered, so a stop that lands after
 * the next start must not end that one.
 */
export function watchEditorRoot(paneId: string, root: string, onChange: (change: EditorFsChange) => void): () => void {
  if (!isTauri()) return () => {};
  watchSeq += 1;
  const watchId = `${paneId}:${watchSeq}`;
  let stopped = false;
  // `listen` resolves to the unlisten function; a stop before that resolves still unlistens.
  const pending = listen<EditorFsChange>("editor://fs-changed", (event) => {
    if (!stopped && event.payload.watchId === watchId) onChange(event.payload);
  }).catch(() => null);
  const started = tauriInvoke("editor_watch_root", { watchId, root }).catch((error) => {
    console.warn("[editor-watch] could not watch", root, error);
  });
  return () => {
    stopped = true;
    void pending.then((off) => off?.());
    // After the start has landed, or a stop that overtakes it would leave its watcher running.
    void started.then(() => tauriInvoke("editor_unwatch", { watchId })).catch(() => {});
  };
}
