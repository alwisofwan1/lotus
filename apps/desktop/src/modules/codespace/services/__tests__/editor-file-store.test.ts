import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: mocks.isTauri,
  tauriInvoke: mocks.invoke,
}));

import {
  allowLargeEditorFile,
  applyDiskFile,
  clearEditorFileBuffer,
  markEditorFileDeleted,
  normalizeMixedLineEndings,
  onEditorFileBufferReleased,
  countUnsavedEditorFiles,
  onUnsavedEditorFilesChange,
  releaseEditorFileBuffer,
  releaseEditorFileHolder,
  setEditorFileHolder,
  getEditorFileBuffer,
  isSaveConflict,
  moveEditorFileBuffers,
  readDiskFile,
  readEditorFile,
  readEditorFileBytes,
  reloadEditorFile,
  saveEditorFile,
  updateEditorFileBuffer,
} from "@/modules/codespace/services/editor-file-store";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";

const SSH_LOCATION: CodeSpaceStoredWorkspaceLocation = {
  kind: "ssh",
  host: "devbox-vps",
  user: "alwi",
  port: 2222,
  remoteCwd: "/home/alwi",
};

describe("editor-file-store", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    clearEditorFileBuffer("/home/alwi/project/src/main.ts");
  });

  it("reads SSH files relative to the active editor root", async () => {
    mocks.invoke.mockResolvedValue({
      content: "hello",
      mtime: 10,
      sizeBytes: 5,
      binary: false,
    });

    const buffer = await readEditorFile("/home/alwi/project/src/main.ts", {
      location: SSH_LOCATION,
      rootDir: "/home/alwi/project",
    });

    expect(buffer.content).toBe("hello");
    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      relativePath: "src/main.ts",
    });
  });

  it("saves SSH files relative to the active editor root", async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        content: "hello",
        mtime: 10,
        sizeBytes: 5,
        binary: false,
      })
      .mockResolvedValueOnce({ mtime: 20 });

    await readEditorFile("/home/alwi/project/src/main.ts", {
      location: SSH_LOCATION,
      rootDir: "/home/alwi/project",
    });
    updateEditorFileBuffer("/home/alwi/project/src/main.ts", "hello world");

    const buffer = await saveEditorFile("/home/alwi/project/src/main.ts", {
      location: SSH_LOCATION,
      rootDir: "/home/alwi/project",
    });

    expect(buffer?.dirty).toBe(false);
    expect(mocks.invoke).toHaveBeenLastCalledWith("editor_write_file_ssh", {
      target: { host: "devbox-vps", user: "alwi", port: 2222 },
      remoteCwd: "/home/alwi/project",
      relativePath: "src/main.ts",
      content: "hello world",
      expectedMtime: 10,
    });
  });
});

describe("moveEditorFileBuffers", () => {
  const read = async (path: string) => {
    mocks.invoke.mockResolvedValueOnce({ content: "saved", mtime: 1, sizeBytes: 5, binary: false });
    await readEditorFile(path);
  };

  beforeEach(() => {
    mocks.invoke.mockReset();
    for (const path of ["/r/a.ts", "/r/b.ts", "/r/src/x.ts", "/r/src/y/z.ts", "/r/lib/x.ts", "/r/lib/y/z.ts", "/r/srcx.ts"]) {
      clearEditorFileBuffer(path);
    }
  });

  it("moves a file's unsaved edits to its new path", async () => {
    await read("/r/a.ts");
    updateEditorFileBuffer("/r/a.ts", "typed");

    moveEditorFileBuffers("/r/a.ts", "/r/b.ts");

    expect(getEditorFileBuffer("/r/a.ts")).toBeNull();
    expect(getEditorFileBuffer("/r/b.ts")).toMatchObject({ path: "/r/b.ts", content: "typed", dirty: true });
  });

  it("moves every buffer under a renamed folder, and nothing that only shares its prefix", async () => {
    await read("/r/src/x.ts");
    await read("/r/src/y/z.ts");
    await read("/r/srcx.ts");

    moveEditorFileBuffers("/r/src", "/r/lib");

    expect(getEditorFileBuffer("/r/lib/x.ts")?.path).toBe("/r/lib/x.ts");
    expect(getEditorFileBuffer("/r/lib/y/z.ts")?.path).toBe("/r/lib/y/z.ts");
    expect(getEditorFileBuffer("/r/src/x.ts")).toBeNull();
    expect(getEditorFileBuffer("/r/srcx.ts")).not.toBeNull();
  });
});

describe("a save refused because the file changed on disk (Editor Revamp 16)", () => {
  const PATH = "/r/conflict.ts";
  const read = (content: string, mtime: number) => mocks.invoke.mockResolvedValueOnce({ content, mtime, sizeBytes: content.length, binary: false });

  beforeEach(() => {
    mocks.invoke.mockReset();
    clearEditorFileBuffer(PATH);
  });

  it("knows the refusal from the local text and from the SSH code", () => {
    expect(isSaveConflict("File has changed on disk")).toBe(true);
    expect(isSaveConflict({ code: "MTIME_CONFLICT", current_mtime: 5 })).toBe(true);
    expect(isSaveConflict("Permission denied")).toBe(false);
    expect(isSaveConflict({ code: "NOT_FOUND" })).toBe(false);
  });

  it("Overwrite writes the buffer once without the mtime check", async () => {
    read("disk", 10);
    await readEditorFile(PATH);
    updateEditorFileBuffer(PATH, "mine");
    mocks.invoke.mockResolvedValueOnce({ mtime: 30 });

    const buffer = await saveEditorFile(PATH, {}, { overwrite: true });

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("editor_write_file", { path: PATH, content: "mine", expectedMtime: undefined });
    expect(buffer).toMatchObject({ dirty: false, mtime: 30 });
  });

  it("reading the disk copy for Compare leaves the unsaved edits alone", async () => {
    read("old", 10);
    await readEditorFile(PATH);
    updateEditorFileBuffer(PATH, "mine");
    read("theirs", 20);

    const disk = await readDiskFile(PATH);

    expect(disk.content).toBe("theirs");
    expect(getEditorFileBuffer(PATH)).toMatchObject({ content: "mine", dirty: true, mtime: 10 });
  });

  it("Reload throws the edits away and takes the disk copy and its mtime", async () => {
    read("old", 10);
    await readEditorFile(PATH);
    updateEditorFileBuffer(PATH, "mine");
    read("theirs", 20);

    const buffer = await reloadEditorFile(PATH);

    expect(buffer).toMatchObject({ content: "theirs", savedContent: "theirs", dirty: false, mtime: 20 });
    expect(getEditorFileBuffer(PATH)).toBe(buffer);
  });
});

describe("applyDiskFile: the file changed on disk while open (Editor Revamp 17)", () => {
  const PATH = "/r/watched.ts";
  const disk = (content: string, mtime: number) => ({ content, mtime, sizeBytes: content.length, binary: false });

  beforeEach(async () => {
    mocks.invoke.mockReset();
    clearEditorFileBuffer(PATH);
    mocks.invoke.mockResolvedValueOnce(disk("v1", 10));
    await readEditorFile(PATH);
  });

  it("a clean buffer takes the new text", () => {
    expect(applyDiskFile(PATH, disk("v2", 20))).toBe("reloaded");
    expect(getEditorFileBuffer(PATH)).toMatchObject({ content: "v2", savedContent: "v2", mtime: 20, dirty: false });
  });

  it("a buffer with edits is left alone and reported as a conflict", () => {
    updateEditorFileBuffer(PATH, "mine");
    expect(applyDiskFile(PATH, disk("v2", 20))).toBe("conflict");
    expect(getEditorFileBuffer(PATH)).toMatchObject({ content: "mine", mtime: 10, dirty: true });
  });

  it("the echo of its own save, or a touch, changes nothing but the mtime", () => {
    expect(applyDiskFile(PATH, disk("v1", 10))).toBe("unchanged");
    updateEditorFileBuffer(PATH, "mine");
    expect(applyDiskFile(PATH, disk("v1", 15))).toBe("unchanged");
    expect(getEditorFileBuffer(PATH)).toMatchObject({ content: "mine", mtime: 15, dirty: true });
  });

  it("a disk that now holds exactly the edits makes the buffer clean", () => {
    updateEditorFileBuffer(PATH, "mine");
    expect(applyDiskFile(PATH, disk("mine", 20))).toBe("unchanged");
    expect(getEditorFileBuffer(PATH)).toMatchObject({ content: "mine", savedContent: "mine", mtime: 20, dirty: false });
  });

  it("the echo of a save still being written is not a conflict, even with keys typed since", async () => {
    updateEditorFileBuffer(PATH, "saving this");
    let finish: (value: { mtime: number }) => void = () => {};
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const saving = saveEditorFile(PATH);
    updateEditorFileBuffer(PATH, "saving this, and more");

    expect(applyDiskFile(PATH, disk("saving this", 20))).toBe("unchanged");

    finish({ mtime: 20 });
    await saving;
    expect(getEditorFileBuffer(PATH)).toMatchObject({ content: "saving this, and more", mtime: 20, dirty: true });
  });

  it("a file with no buffer is not read in", () => {
    expect(applyDiskFile("/r/never-opened.ts", disk("x", 1))).toBe("unchanged");
    expect(getEditorFileBuffer("/r/never-opened.ts")).toBeNull();
  });
});

describe("media viewer reads", () => {
  const PATH = "/r/logo.png";

  beforeEach(() => {
    mocks.invoke.mockReset();
    clearEditorFileBuffer(PATH);
  });

  it("reads a workspace file's bytes by its path relative to the root", async () => {
    const bytes = new Uint8Array([0x89, 0x50]).buffer;
    mocks.invoke.mockResolvedValueOnce(bytes);
    await expect(readEditorFileBytes(PATH, { rootDir: "/r" })).resolves.toBe(bytes);
    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file_bytes", { path: "/r/logo.png" });
  });

  it("reads an SSH workspace file's bytes through the remote command", async () => {
    mocks.invoke.mockResolvedValueOnce(new ArrayBuffer(0));
    await readEditorFileBytes("/home/alwi/project/a.png", { location: SSH_LOCATION, rootDir: "/home/alwi/project" });
    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file_bytes_ssh", expect.objectContaining({
      remoteCwd: "/home/alwi/project",
      relativePath: "a.png",
    }));
  });

  it("a binary file with a new mtime or size is reloaded, so the viewer reads it again", async () => {
    const binaryDisk = (mtime: number, sizeBytes: number) => ({ content: "", mtime, sizeBytes, binary: true });
    mocks.invoke.mockResolvedValueOnce(binaryDisk(10, 100));
    await readEditorFile(PATH);
    expect(applyDiskFile(PATH, binaryDisk(10, 100))).toBe("unchanged");
    expect(applyDiskFile(PATH, binaryDisk(20, 120))).toBe("reloaded");
    expect(getEditorFileBuffer(PATH)).toMatchObject({ mtime: 20, sizeBytes: 120, binary: true, dirty: false });
  });
});

describe("two panes on one file share its buffer", () => {
  const PATH = "/r/shared.ts";
  const read = () => mocks.invoke.mockResolvedValueOnce({ content: "v1", mtime: 1, sizeBytes: 2, binary: false });

  beforeEach(async () => {
    mocks.invoke.mockReset();
    releaseEditorFileHolder("pane-a");
    releaseEditorFileHolder("pane-b");
    clearEditorFileBuffer(PATH);
    read();
    await readEditorFile(PATH);
    setEditorFileHolder("pane-a", [PATH]);
    setEditorFileHolder("pane-b", [PATH]);
  });

  it("closing the tab in one pane keeps the other pane's unsaved edits", () => {
    updateEditorFileBuffer(PATH, "edited in B");
    releaseEditorFileBuffer(PATH, "pane-a");
    expect(getEditorFileBuffer(PATH)).toMatchObject({ content: "edited in B", dirty: true });
  });

  it("the buffer goes once the last pane holding it lets go", () => {
    releaseEditorFileBuffer(PATH, "pane-a");
    releaseEditorFileBuffer(PATH, "pane-b");
    expect(getEditorFileBuffer(PATH)).toBeNull();
  });

  it("closing a whole pane releases its files, except those another pane holds", () => {
    releaseEditorFileHolder("pane-a", [PATH]);
    expect(getEditorFileBuffer(PATH)).not.toBeNull();
    releaseEditorFileHolder("pane-b");
    expect(getEditorFileBuffer(PATH)).toBeNull();
  });

  it("tells listeners how many files are unsaved, only when the number changes", () => {
    const counts: number[] = [];
    const stop = onUnsavedEditorFilesChange((count) => counts.push(count));
    const before = countUnsavedEditorFiles();
    updateEditorFileBuffer(PATH, "a");
    updateEditorFileBuffer(PATH, "ab");
    updateEditorFileBuffer(PATH, "v1");
    stop();
    expect(counts).toEqual([before + 1, before]);
  });
});

describe("one save at a time per file", () => {
  const PATH = "/r/race.ts";

  beforeEach(async () => {
    mocks.invoke.mockReset();
    clearEditorFileBuffer(PATH);
    mocks.invoke.mockResolvedValueOnce({ content: "v1", mtime: 10, sizeBytes: 2, binary: false });
    await readEditorFile(PATH);
  });

  it("a second ⌘S during the first write sends the new mtime, not a false conflict", async () => {
    let finishFirst: (value: { mtime: number }) => void = () => {};
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    mocks.invoke.mockResolvedValueOnce({ mtime: 30 });

    updateEditorFileBuffer(PATH, "v2");
    const first = saveEditorFile(PATH);
    updateEditorFileBuffer(PATH, "v3");
    const second = saveEditorFile(PATH);

    finishFirst({ mtime: 20 });
    await first;
    await expect(second).resolves.toMatchObject({ content: "v3", mtime: 30, dirty: false });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "editor_write_file", { path: PATH, content: "v2", expectedMtime: 10 });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "editor_write_file", { path: PATH, content: "v3", expectedMtime: 20 });
  });

  it("a save with nothing left to write after the one before it writes nothing", async () => {
    mocks.invoke.mockResolvedValueOnce({ mtime: 20 });
    updateEditorFileBuffer(PATH, "v2");
    const first = saveEditorFile(PATH);
    const second = saveEditorFile(PATH);
    await Promise.all([first, second]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2); // the read, and one write
  });
});

describe("a file outside the workspace root", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("is read locally by its own path, not joined onto the root", async () => {
    mocks.invoke.mockResolvedValueOnce({ content: "x", mtime: 1, sizeBytes: 1, binary: false });
    await readDiskFile("/Users/me/other-repo/a.ts", { rootDir: "/Users/me/repo" });
    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file", { path: "/Users/me/other-repo/a.ts" });
  });

  it("does not take a sibling folder that shares the root's name as inside it", async () => {
    mocks.invoke.mockResolvedValueOnce({ content: "x", mtime: 1, sizeBytes: 1, binary: false });
    await readDiskFile("/Users/me/repo2/a.ts", { rootDir: "/Users/me/repo" });
    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file", { path: "/Users/me/repo2/a.ts" });
  });

  it("is read over SSH from its own folder", async () => {
    mocks.invoke.mockResolvedValueOnce({ content: "x", mtime: 1, sizeBytes: 1, binary: false });
    await readDiskFile("/home/alwi/other/b.ts", { location: SSH_LOCATION, rootDir: "/home/alwi/project" });
    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file_ssh", expect.objectContaining({
      remoteCwd: "/home/alwi/other",
      relativePath: "b.ts",
    }));
  });

  it("inside the root still goes by the root and the path below it", async () => {
    mocks.invoke.mockResolvedValueOnce({ content: "x", mtime: 1, sizeBytes: 1, binary: false });
    await readDiskFile("/home/alwi/project/src/c.ts", { location: SSH_LOCATION, rootDir: "/home/alwi/project" });
    expect(mocks.invoke).toHaveBeenCalledWith("editor_read_file_ssh", expect.objectContaining({
      remoteCwd: "/home/alwi/project",
      relativePath: "src/c.ts",
    }));
  });
});

describe("mixed line endings", () => {
  it("become the ending most lines use, as Monaco does, so a file does not open dirty", () => {
    expect(normalizeMixedLineEndings("a\r\nb\r\nc\n")).toBe("a\r\nb\r\nc\r\n");
    expect(normalizeMixedLineEndings("a\nb\nc\r\n")).toBe("a\nb\nc\n");
    expect(normalizeMixedLineEndings("a\rb\n")).toBe("a\nb\n");
  });

  it("leave a file with one kind of ending, or none, exactly as it is", () => {
    for (const text of ["a\nb\n", "a\r\nb\r\n", "one line", ""]) {
      expect(normalizeMixedLineEndings(text)).toBe(text);
    }
  });

  it("are normalised on the way in, so the buffer is not dirty against the disk", async () => {
    mocks.invoke.mockReset().mockResolvedValueOnce({ content: "a\r\nb\n", mtime: 1, sizeBytes: 5, binary: false });
    const buffer = await readEditorFile("/repo/mixed.txt");
    expect(buffer.content).toBe("a\nb\n");
    expect(updateEditorFileBuffer("/repo/mixed.txt", "a\nb\n")?.dirty).toBe(false);
    clearEditorFileBuffer("/repo/mixed.txt");
  });
});

describe("encodings, large files and deleted files", () => {
  const PATH = "/repo/latin.txt";
  beforeEach(() => {
    mocks.invoke.mockReset();
    clearEditorFileBuffer(PATH);
  });

  it("a save writes the file back in the encoding it was read in", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ content: "café", mtime: 1, sizeBytes: 4, binary: false, encoding: "windows1252" })
      .mockResolvedValueOnce({ mtime: 2 });
    await readEditorFile(PATH);
    updateEditorFileBuffer(PATH, "café!");
    await saveEditorFile(PATH);
    expect(mocks.invoke).toHaveBeenLastCalledWith("editor_write_file", {
      path: PATH, content: "café!", expectedMtime: 1, encoding: "windows1252",
    });
  });

  it("a large file the user chose to open is read with the large cap from then on", async () => {
    mocks.invoke.mockResolvedValue({ content: "", mtime: 1, sizeBytes: 20_000_000, binary: true, tooLarge: true });
    expect((await readEditorFile(PATH)).tooLarge).toBe(true);
    expect(mocks.invoke).toHaveBeenLastCalledWith("editor_read_file", { path: PATH });
    allowLargeEditorFile(PATH);
    await readDiskFile(PATH);
    expect(mocks.invoke).toHaveBeenLastCalledWith("editor_read_file", { path: PATH, allowLarge: true });
  });

  it("a file deleted on disk keeps its text, and comes back clean when it reappears", async () => {
    mocks.invoke.mockResolvedValueOnce({ content: "x", mtime: 1, sizeBytes: 1, binary: false });
    await readEditorFile(PATH);
    expect(markEditorFileDeleted(PATH)).toBe(true);
    expect(markEditorFileDeleted(PATH)).toBe(false);
    expect(getEditorFileBuffer(PATH)).toMatchObject({ content: "x", deleted: true });
    applyDiskFile(PATH, { content: "x", mtime: 5, sizeBytes: 1, binary: false });
    expect(getEditorFileBuffer(PATH)).toMatchObject({ deleted: false, dirty: false, mtime: 5 });
  });

  it("tells listeners when no pane holds a file any more, so its Monaco model can go", async () => {
    const released: string[] = [];
    const stop = onEditorFileBufferReleased((path) => released.push(path));
    mocks.invoke.mockResolvedValueOnce({ content: "x", mtime: 1, sizeBytes: 1, binary: false });
    await readEditorFile(PATH);
    setEditorFileHolder("pane-a", [PATH]);
    setEditorFileHolder("pane-b", [PATH]);
    releaseEditorFileBuffer(PATH, "pane-a");
    expect(released).toEqual([]);
    releaseEditorFileBuffer(PATH, "pane-b");
    expect(released).toEqual([PATH]);
    releaseEditorFileHolder("pane-a");
    releaseEditorFileHolder("pane-b");
    stop();
  });
});
