/*
 * A server's workspace edit (rename, a quick fix, organize imports) applied to the files.
 *
 * As VS Code: a file open in the editor is edited in place and left unsaved, with one undo step;
 * the user sees and saves it. A file not open is edited on disk at once, through the same
 * conflict-checked save as the editor's — leaving it unsaved would hide edits no tab shows.
 */

import type { editor } from "monaco-editor";
import {
  clearEditorFileBuffer,
  getEditorFileBuffer,
  heldByAnotherPane,
  readEditorFile,
  saveEditorFile,
  updateEditorFileBuffer,
  type EditorFileIoContext,
} from "@/modules/codespace/services/editor-file-store";
import { applyTextEdits, toMonacoRange, workspaceEditFiles, type MonacoApi } from "./lsp-convert";
import type { LspWorkspaceEdit } from "./lsp-types";

export type AppliedWorkspaceEdit = {
  /** Files changed: open ones (unsaved now) and closed ones (saved). */
  files: string[];
  saved: string[];
  failed: Array<{ path: string; error: string }>;
};

/** No pane holds this id: a file read only to be edited is not anyone's tab. */
const EDIT_HOLDER = "lsp-workspace-edit";

export async function applyLspWorkspaceEdit(
  monaco: Pick<MonacoApi, "Uri" | "editor">,
  edit: LspWorkspaceEdit,
  context: EditorFileIoContext,
): Promise<AppliedWorkspaceEdit> {
  const { files, unsupported } = workspaceEditFiles(edit);
  if (unsupported) throw new Error("This change creates, renames or deletes files, which the editor cannot do yet.");
  const applied: AppliedWorkspaceEdit = { files: [], saved: [], failed: [] };
  for (const [path, edits] of files) {
    if (edits.length === 0) continue;
    try {
      const model = monaco.editor.getModel(monaco.Uri.file(path)) as editor.ITextModel | null;
      const buffer = getEditorFileBuffer(path);
      if (model && (model.isAttachedToEditor() || buffer)) {
        model.pushStackElement();
        model.pushEditOperations([], edits.map((item) => ({ range: toMonacoRange(item.range), text: item.newText })), () => null);
        model.pushStackElement();
        // A shown model tells its buffer through the editor; one in a tab not shown does not.
        if (!model.isAttachedToEditor()) updateEditorFileBuffer(path, model.getValue());
        applied.files.push(path);
        continue;
      }
      if (buffer) {
        updateEditorFileBuffer(path, applyTextEdits(buffer.content, edits));
        applied.files.push(path);
        continue;
      }
      const disk = await readEditorFile(path, context);
      if (disk.binary) throw new Error("not a text file");
      updateEditorFileBuffer(path, applyTextEdits(disk.content, edits));
      try {
        await saveEditorFile(path, context);
      } finally {
        // Opened in a tab while this ran: the tab keeps it.
        if (!heldByAnotherPane(path, EDIT_HOLDER)) clearEditorFileBuffer(path);
      }
      applied.files.push(path);
      applied.saved.push(path);
    } catch (error) {
      applied.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return applied;
}
