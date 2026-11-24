import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyExternalContent } from "../editor-content-sync";
import type { editor } from "monaco-editor";

function makeMockEditor(currentValue: string): editor.IStandaloneCodeEditor {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 99, endColumn: 1 };
  const model = {
    getValue: vi.fn(() => currentValue),
    getFullModelRange: vi.fn(() => range),
    pushEditOperations: vi.fn(),
  } as unknown as editor.ITextModel;

  return {
    getModel: vi.fn(() => model),
    pushUndoStop: vi.fn(),
  } as unknown as editor.IStandaloneCodeEditor;
}

describe("applyExternalContent", () => {
  let editor: editor.IStandaloneCodeEditor;

  beforeEach(() => {
    editor = makeMockEditor("initial content");
  });

  it("is a no-op when new content matches current model value", () => {
    applyExternalContent(editor, "initial content");

    expect(editor.pushUndoStop).not.toHaveBeenCalled();
    const model = editor.getModel()!;
    expect(model.pushEditOperations).not.toHaveBeenCalled();
  });

  it("applies edit operations when content differs", () => {
    applyExternalContent(editor, "new content from git restore");

    const model = editor.getModel()!;
    expect(model.pushEditOperations).toHaveBeenCalledOnce();
    const [, edits] = (model.pushEditOperations as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe("new content from git restore");
  });

  it("wraps the edit with undo stops to form a discrete undo entry", () => {
    applyExternalContent(editor, "new content");

    expect(editor.pushUndoStop).toHaveBeenCalledTimes(2);
  });

  it("does not call pushEditOperations when model is null", () => {
    const nullModelEditor = {
      getModel: vi.fn(() => null),
      pushUndoStop: vi.fn(),
    } as unknown as editor.IStandaloneCodeEditor;

    expect(() => applyExternalContent(nullModelEditor, "anything")).not.toThrow();
    expect(nullModelEditor.pushUndoStop).not.toHaveBeenCalled();
  });

  it("uses the full model range as the replacement target", () => {
    const customRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 20 };
    const model = editor.getModel()!;
    (model.getFullModelRange as ReturnType<typeof vi.fn>).mockReturnValue(customRange);

    applyExternalContent(editor, "replacement");

    const [, edits] = (model.pushEditOperations as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(edits[0].range).toBe(customRange);
  });
});
