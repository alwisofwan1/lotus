import type { editor } from "monaco-editor";

/**
 * Applies an externally-sourced content change to Monaco without clearing the
 * undo history.  Use this instead of model.setValue() whenever the content
 * change originates outside the user's keystrokes (file reload, git discard,
 * post-save normalisation).
 *
 * If the new content is identical to what the model already holds the call is
 * a no-op so the undo stack is never disturbed.
 *
 * Two pushUndoStop() calls bracket the edit so the external change lands as a
 * single, discrete entry in the undo history rather than being merged with
 * adjacent user edits.
 */
export function applyExternalContent(
  editorInstance: editor.IStandaloneCodeEditor,
  content: string,
): void {
  const model = editorInstance.getModel();
  if (!model) return;
  if (model.getValue() === content) return;

  editorInstance.pushUndoStop();
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: content }],
    () => null,
  );
  editorInstance.pushUndoStop();
}
