import { describe, expect, it, vi } from "vitest";
import { formatIndent, watchEditorStatus, type EditorStatusSource } from "../editor-status";

function fakeEditor() {
  const listeners = { cursor: [] as Array<() => void>, model: [] as Array<() => void>, options: [] as Array<() => void> };
  const on = (list: Array<() => void>) => (listener: () => void) => {
    list.push(listener);
    return { dispose: () => list.splice(list.indexOf(listener), 1) };
  };
  const state = { position: { lineNumber: 1, column: 1 }, options: { insertSpaces: true, tabSize: 2 }, hasModel: true };
  const editor: EditorStatusSource = {
    getPosition: () => state.position,
    getModel: () => (state.hasModel ? { getOptions: () => state.options } : null),
    onDidChangeCursorPosition: on(listeners.cursor),
    onDidChangeModel: on(listeners.model),
    onDidChangeModelOptions: on(listeners.options),
  };
  const fire = (list: Array<() => void>) => list.forEach((listener) => listener());
  return { editor, state, listeners, fire };
}

describe("editor status", () => {
  it("reports the cursor at once and each time it moves", () => {
    const { editor, state, listeners, fire } = fakeEditor();
    const onChange = vi.fn();
    watchEditorStatus(editor, onChange);
    expect(onChange).toHaveBeenLastCalledWith({ line: 1, column: 1, insertSpaces: true, tabSize: 2, eol: "LF" });

    state.position = { lineNumber: 42, column: 18 };
    fire(listeners.cursor);
    expect(onChange).toHaveBeenLastCalledWith({ line: 42, column: 18, insertSpaces: true, tabSize: 2, eol: "LF" });
  });

  it("reports the indentation the file was found to use, and a new file's", () => {
    const { editor, state, listeners, fire } = fakeEditor();
    const onChange = vi.fn();
    watchEditorStatus(editor, onChange);

    state.options = { insertSpaces: false, tabSize: 4 };
    fire(listeners.options);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ insertSpaces: false, tabSize: 4 }));

    state.hasModel = false;
    fire(listeners.model);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("stops listening when disposed", () => {
    const { editor, listeners } = fakeEditor();
    const dispose = watchEditorStatus(editor, vi.fn());
    dispose();
    expect(listeners.cursor).toHaveLength(0);
    expect(listeners.model).toHaveLength(0);
    expect(listeners.options).toHaveLength(0);
  });

  it("names the indentation as VS Code does", () => {
    expect(formatIndent({ insertSpaces: true, tabSize: 4 })).toBe("Spaces: 4");
    expect(formatIndent({ insertSpaces: false, tabSize: 8 })).toBe("Tab Size: 8");
  });
});

describe("line endings", () => {
  it("reports CRLF, and again when only the line endings change", () => {
    let eol = "\r\n";
    const content: Array<(event: { isEolChange?: boolean }) => void> = [];
    const noop = () => ({ dispose: () => {} });
    const editor: EditorStatusSource = {
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      getModel: () => ({ getOptions: () => ({ insertSpaces: true, tabSize: 2 }), getEOL: () => eol }),
      onDidChangeCursorPosition: noop,
      onDidChangeModel: noop,
      onDidChangeModelOptions: noop,
      onDidChangeModelContent: (listener) => {
        content.push(listener);
        return { dispose: () => {} };
      },
    };
    const onChange = vi.fn();
    watchEditorStatus(editor, onChange);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ eol: "CRLF" }));

    eol = "\n";
    content[0]({ isEolChange: false });
    expect(onChange).toHaveBeenCalledTimes(1);
    content[0]({ isEolChange: true });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ eol: "LF" }));
  });
});
