import { getEditorFileBuffer, onEditorFileBufferReleased } from "./editor-file-store";

type MonacoModels = {
  Uri: { parse(value: string): unknown };
  editor: {
    getModel(uri: never): { isAttachedToEditor(): boolean; dispose(): void } | null;
  };
};

/**
 * Frees the Monaco model of a file no pane has open. `@monaco-editor/react` keeps one model per
 * `path` (keyed `Uri.parse(path)`) and never frees one it switched away from, so every file ever
 * opened kept its whole text, undo stack and tokens in memory until the window closed.
 *
 * A model still shown by an editor is left alone: the release can land before the pane has moved
 * to its next file, and the pane frees it then (it calls this again for the path it left).
 */
export function disposeDetachedEditorModel(monaco: unknown, path: string): void {
  if (getEditorFileBuffer(path)) return;
  const api = monaco as Partial<MonacoModels> | null;
  if (!api?.Uri || !api.editor?.getModel) return;
  const model = api.editor.getModel(api.Uri.parse(path) as never);
  if (model && !model.isAttachedToEditor()) model.dispose();
}

let reaperMonaco: unknown = null;

/**
 * Once for the app: a file no pane holds any more gives its model back. Not tied to an editor
 * on screen: the editors keep their model when they hide (a Markdown preview, an image tab), so
 * a tab closed meanwhile would otherwise keep its model until the window closed.
 */
export function installEditorModelReaper(monaco: unknown): void {
  const installed = reaperMonaco !== null;
  reaperMonaco = monaco;
  if (installed) return;
  onEditorFileBufferReleased((released) => disposeDetachedEditorModel(reaperMonaco, released));
}
