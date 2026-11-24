import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  buffers: new Map<string, { content: string }>(),
  saved: [] as string[],
  held: new Set<string>(),
}));

vi.mock("@/modules/codespace/services/editor-file-store", () => ({
  getEditorFileBuffer: (path: string) => store.buffers.get(path) ?? null,
  updateEditorFileBuffer: (path: string, content: string) => {
    store.buffers.set(path, { content });
    return { content };
  },
  readEditorFile: async (path: string) => ({ path, content: "old name\n", binary: false }),
  saveEditorFile: async (path: string) => {
    store.saved.push(`${path}:${store.buffers.get(path)?.content}`);
  },
  clearEditorFileBuffer: (path: string) => store.buffers.delete(path),
  heldByAnotherPane: (path: string) => store.held.has(path),
}));

import { applyLspWorkspaceEdit } from "../lsp-workspace-edit";

const monaco = {
  Uri: { file: (path: string) => path },
  editor: { getModel: () => null },
} as never;

const rename = (uri: string) => ({ [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "new" }] });

describe("applyLspWorkspaceEdit", () => {
  beforeEach(() => {
    store.buffers.clear();
    store.saved = [];
    store.held.clear();
  });

  it("edits an open buffer without saving it", async () => {
    store.buffers.set("/a.ts", { content: "old a" });
    const result = await applyLspWorkspaceEdit(monaco, { changes: rename("file:///a.ts") }, {});
    expect(result).toEqual({ files: ["/a.ts"], saved: [], failed: [] });
    expect(store.buffers.get("/a.ts")?.content).toBe("new a");
  });

  it("edits a closed file on disk and lets its buffer go", async () => {
    const result = await applyLspWorkspaceEdit(monaco, { changes: rename("file:///b.ts") }, {});
    expect(result.saved).toEqual(["/b.ts"]);
    expect(store.saved).toEqual(["/b.ts:new name\n"]);
    expect(store.buffers.has("/b.ts")).toBe(false);
  });

  it("refuses edits that create, rename or delete files", async () => {
    await expect(applyLspWorkspaceEdit(monaco, { documentChanges: [{ kind: "rename", oldUri: "file:///a", newUri: "file:///b" }] } as never, {}))
      .rejects.toThrow(/creates, renames or deletes/);
  });
});
