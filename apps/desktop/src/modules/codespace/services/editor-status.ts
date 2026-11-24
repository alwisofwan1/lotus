/** What the status bar shows about the editor: where the cursor is and how the file is indented. */
export type EditorStatus = {
  line: number;
  column: number;
  insertSpaces: boolean;
  tabSize: number;
  /** The file's line endings, as Monaco keeps them (and saves them). */
  eol: "LF" | "CRLF";
};

type Disposable = { dispose: () => void };

/** The part of Monaco's code editor this reads. */
export type EditorStatusSource = {
  getPosition: () => { lineNumber: number; column: number } | null;
  getModel: () => { getOptions: () => { insertSpaces: boolean; tabSize: number }; getEOL?: () => string } | null;
  onDidChangeCursorPosition: (listener: () => void) => Disposable;
  onDidChangeModel: (listener: () => void) => Disposable;
  onDidChangeModelOptions: (listener: () => void) => Disposable;
  onDidChangeModelContent?: (listener: (event: { isEolChange?: boolean }) => void) => Disposable;
};

/**
 * Report the status now and each time the cursor moves, the file changes, or its indentation is
 * worked out (Monaco detects it from the content). `null` while no file is in the editor.
 */
export function watchEditorStatus(editor: EditorStatusSource, onChange: (status: EditorStatus | null) => void): () => void {
  const report = () => {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) {
      onChange(null);
      return;
    }
    const { insertSpaces, tabSize } = model.getOptions();
    const eol = model.getEOL?.() === "\r\n" ? "CRLF" : "LF";
    onChange({ line: position.lineNumber, column: position.column, insertSpaces, tabSize, eol });
  };
  const subscriptions = [
    editor.onDidChangeCursorPosition(report),
    editor.onDidChangeModel(report),
    editor.onDidChangeModelOptions(report),
    // Only a change of line endings: typing already moves the cursor.
    ...(editor.onDidChangeModelContent ? [editor.onDidChangeModelContent((event) => {
      if (event.isEolChange) report();
    })] : []),
  ];
  report();
  return () => subscriptions.forEach((subscription) => subscription.dispose());
}

export function formatIndent(status: Pick<EditorStatus, "insertSpaces" | "tabSize">): string {
  return status.insertSpaces ? `Spaces: ${status.tabSize}` : `Tab Size: ${status.tabSize}`;
}
