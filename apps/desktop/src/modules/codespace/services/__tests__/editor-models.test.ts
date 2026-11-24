import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ buffers: new Set<string>(), released: [] as Array<(path: string) => void> }));
vi.mock("@/modules/codespace/services/editor-file-store", () => ({
  getEditorFileBuffer: (path: string) => (store.buffers.has(path) ? { path } : null),
  onEditorFileBufferReleased: (listener: (path: string) => void) => {
    store.released.push(listener);
    return () => {};
  },
}));

import { disposeDetachedEditorModel, installEditorModelReaper } from "@/modules/codespace/services/editor-models";

function fakeMonaco(attached: boolean) {
  const model = { isAttachedToEditor: () => attached, dispose: vi.fn() };
  const monaco = {
    Uri: { parse: (value: string) => `uri:${value}` },
    editor: { getModel: vi.fn((uri: string) => (uri === "uri:/repo/a.ts" ? model : null)) },
  };
  return { monaco, model };
}

describe("disposeDetachedEditorModel", () => {
  it("frees the model of a file no pane holds and no editor shows", () => {
    const { monaco, model } = fakeMonaco(false);
    disposeDetachedEditorModel(monaco, "/repo/a.ts");
    expect(monaco.editor.getModel).toHaveBeenCalledWith("uri:/repo/a.ts");
    expect(model.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps a model an editor still shows, and one whose file is still open", () => {
    const shown = fakeMonaco(true);
    disposeDetachedEditorModel(shown.monaco, "/repo/a.ts");
    expect(shown.model.dispose).not.toHaveBeenCalled();

    store.buffers.add("/repo/a.ts");
    const open = fakeMonaco(false);
    disposeDetachedEditorModel(open.monaco, "/repo/a.ts");
    expect(open.model.dispose).not.toHaveBeenCalled();
    store.buffers.clear();
  });

  it("does nothing without a Monaco instance or a model", () => {
    expect(() => disposeDetachedEditorModel(null, "/repo/a.ts")).not.toThrow();
    const { monaco } = fakeMonaco(false);
    expect(() => disposeDetachedEditorModel(monaco, "/repo/other.ts")).not.toThrow();
  });
});

describe("installEditorModelReaper", () => {
  it("frees a released file's model with no editor mounted, listening once", () => {
    const first = fakeMonaco(false);
    const latest = fakeMonaco(false);
    installEditorModelReaper(first.monaco);
    installEditorModelReaper(latest.monaco);
    expect(store.released).toHaveLength(1);
    store.released[0]("/repo/a.ts");
    expect(latest.model.dispose).toHaveBeenCalled();
    expect(first.model.dispose).not.toHaveBeenCalled();
  });
});
