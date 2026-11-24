import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: io.editorWriteFileFor,
}));

vi.mock("@/lib/tauri-api", () => ({
  editorReadFile: vi.fn(),
  editorWriteFile: vi.fn(),
}));

import {
  clearEditorFileBuffer,
  getEditorFileBuffer,
  readEditorFile,
  updateEditorFileBuffer,
} from "@/modules/codespace/services/editor-file-store";
import { saveUnsavedFiles, unsavedFilePaths } from "@/modules/codespace/services/unsaved-changes";
import type { WorkbenchTab } from "@/modules/codespace/components/types";

const root = "/repo";
const ctx = { location: null, rootDir: root };

async function open(path: string, edit?: string) {
  io.editorReadFileFor.mockResolvedValueOnce({ content: "saved", mtime: 1, sizeBytes: 5, binary: false });
  await readEditorFile(path, ctx);
  if (edit !== undefined) updateEditorFileBuffer(path, edit);
}

const fileTab = (id: string, filePath: string, dirty?: boolean): WorkbenchTab => ({ id, kind: "file", filePath, dirty });

describe("unsaved changes", () => {
  beforeEach(() => {
    io.editorReadFileFor.mockReset();
    io.editorWriteFileFor.mockReset();
    for (const path of ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"]) clearEditorFileBuffer(path);
  });

  it("lists only file tabs whose buffer holds unsaved edits", async () => {
    await open("/repo/a.ts", "edited");
    await open("/repo/b.ts");
    await open("/repo/c.ts", "saved");

    const tabs: WorkbenchTab[] = [
      fileTab("1", "/repo/a.ts"),
      fileTab("2", "/repo/b.ts", true),
      fileTab("3", "/repo/c.ts"),
      { id: "4", kind: "url", url: "https://example.com" },
    ];

    expect(unsavedFilePaths(tabs)).toEqual(["/repo/a.ts"]);
  });

  it("ignores a tab flagged dirty when no buffer is loaded (nothing to save)", () => {
    expect(unsavedFilePaths([fileTab("1", "/repo/a.ts", true)])).toEqual([]);
  });

  it("saves every file and reports no failure", async () => {
    await open("/repo/a.ts", "edited a");
    await open("/repo/b.ts", "edited b");
    io.editorWriteFileFor.mockResolvedValue({ mtime: 2 });

    const result = await saveUnsavedFiles(["/repo/a.ts", "/repo/b.ts"], ctx);

    expect(result).toEqual({ failed: null });
    expect(io.editorWriteFileFor).toHaveBeenCalledTimes(2);
    expect(getEditorFileBuffer("/repo/a.ts")?.dirty).toBe(false);
  });

  it("stops at the first file that fails and says which one and why", async () => {
    await open("/repo/a.ts", "edited a");
    await open("/repo/b.ts", "edited b");
    io.editorWriteFileFor.mockRejectedValueOnce(new Error("File has changed on disk"));

    const result = await saveUnsavedFiles(["/repo/a.ts", "/repo/b.ts"], ctx);

    expect(result).toEqual({ failed: { path: "/repo/a.ts", message: "File has changed on disk", conflict: true } });
    expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1);
    expect(getEditorFileBuffer("/repo/a.ts")?.dirty).toBe(true);
  });

  it("says what went wrong over SSH instead of [object Object]", async () => {
    await open("/repo/a.ts", "edited a");
    io.editorWriteFileFor.mockRejectedValueOnce({ code: "TOO_LARGE", size: 2048, limit: 1024 });

    const result = await saveUnsavedFiles(["/repo/a.ts"], ctx);

    expect(result.failed).toEqual({ path: "/repo/a.ts", message: "Remote file is too large (2.0 KB / 1.0 KB limit).", conflict: false });
  });

  it("keeps keys typed while the save was running", async () => {
    await open("/repo/a.ts", "first");
    let finishWrite: (value: { mtime: number }) => void = () => {};
    io.editorWriteFileFor.mockReturnValueOnce(new Promise((resolve) => { finishWrite = resolve; }));

    const saving = saveUnsavedFiles(["/repo/a.ts"], ctx);
    updateEditorFileBuffer("/repo/a.ts", "first and more");
    finishWrite({ mtime: 2 });
    await saving;

    const buffer = getEditorFileBuffer("/repo/a.ts");
    expect(buffer?.content).toBe("first and more");
    expect(buffer?.savedContent).toBe("first");
    expect(buffer?.dirty).toBe(true);
  });
});
