import type { WorkbenchTab } from "@/modules/codespace/components/types";
import { formatRemoteError, parseRemoteError } from "@/lib/tauri/remote-error";
import {
  getEditorFileBuffer,
  isSaveConflict,
  saveEditorFile,
  type EditorFileIoContext,
} from "@/modules/codespace/services/editor-file-store";

/**
 * Files in these tabs that hold edits not yet on disk.
 *
 * The buffer is the source of truth, not `tab.dirty`: the flag is persisted with the cell and
 * can outlive its buffer (after a reload there is nothing left to save), and it is not reset
 * when an edit is typed back to the saved text.
 */
export function unsavedFilePaths(tabs: readonly WorkbenchTab[]): string[] {
  return tabs.flatMap((tab) =>
    tab.kind === "file" && getEditorFileBuffer(tab.filePath)?.dirty ? [tab.filePath] : [],
  );
}

/** `conflict`: refused because the file changed on disk, which the pane answers with its banner. */
export type SaveUnsavedResult = { failed: { path: string; message: string; conflict: boolean } | null };

/** Saves in order and stops at the first failure, so the caller can keep the pane open. */
export async function saveUnsavedFiles(
  paths: readonly string[],
  context: EditorFileIoContext,
): Promise<SaveUnsavedResult> {
  for (const path of paths) {
    try {
      await saveEditorFile(path, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : formatRemoteError(parseRemoteError(error));
      return { failed: { path, message, conflict: isSaveConflict(error) } };
    }
  }
  return { failed: null };
}
