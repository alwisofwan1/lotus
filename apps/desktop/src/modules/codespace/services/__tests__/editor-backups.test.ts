import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disk: new Map<string, { content: string; mtime: number }>(),
  backups: new Map<string, string>(),
  backupReadFails: false,
}));

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: () => true,
  tauriInvoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "editor_read_file": {
        const file = mocks.disk.get(args.path as string);
        if (!file) throw "IO error: No such file or directory (os error 2)";
        return { content: file.content, mtime: file.mtime, sizeBytes: file.content.length, binary: false };
      }
      case "editor_write_file":
        mocks.disk.set(args.path as string, { content: args.content as string, mtime: 99 });
        return { mtime: 99 };
      case "editor_backup_write":
        mocks.backups.set(args.key as string, args.data as string);
        return undefined;
      case "editor_backup_read":
        if (mocks.backupReadFails) throw new Error("disk unreadable");
        return mocks.backups.get(args.key as string) ?? null;
      case "editor_backup_delete":
        mocks.backups.delete(args.key as string);
        return undefined;
      default:
        throw new Error(`unexpected ${command}`);
    }
  }),
}));

import {
  discardEditorBackups,
  EDITOR_BACKUP_DELAY_MS,
  editorBackupKey,
  flushEditorBackups,
  openEditorFile,
  resetEditorBackupsForTest,
  restoreEditorBackup,
  startEditorBackups,
} from "@/modules/codespace/services/editor-backups";
import {
  clearEditorFileBuffer,
  getEditorFileBuffer,
  readEditorFile,
  saveEditorFile,
  updateEditorFileBuffer,
} from "@/modules/codespace/services/editor-file-store";

const PATH = "/repo/a.ts";
const KEY = editorBackupKey(PATH);

const backupOf = (content: string, savedContent: string, mtime = 1) =>
  JSON.stringify({ v: 1, path: PATH, content, savedContent, mtime, savedAt: 0 });

describe("editor hot-exit backups", () => {
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.disk.clear();
    mocks.backups.clear();
    mocks.backupReadFails = false;
    resetEditorBackupsForTest();
    clearEditorFileBuffer(PATH);
    stop = startEditorBackups();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  const settle = async () => {
    await vi.advanceTimersByTimeAsync(EDITOR_BACKUP_DELAY_MS);
    await flushEditorBackups();
  };

  it("copies an unsaved buffer once typing pauses, and drops the copy on save", async () => {
    mocks.disk.set(PATH, { content: "a", mtime: 1 });
    await readEditorFile(PATH);
    updateEditorFileBuffer(PATH, "ab");
    updateEditorFileBuffer(PATH, "abc");
    expect(mocks.backups.size).toBe(0);
    await settle();
    expect(JSON.parse(mocks.backups.get(KEY)!)).toMatchObject({ content: "abc", savedContent: "a", mtime: 1 });

    await saveEditorFile(PATH);
    await flushEditorBackups();
    expect(mocks.backups.has(KEY)).toBe(false);
  });

  it("drops the copy when the edits are typed away or the buffer is discarded", async () => {
    mocks.disk.set(PATH, { content: "a", mtime: 1 });
    await readEditorFile(PATH);
    updateEditorFileBuffer(PATH, "ab");
    await settle();
    updateEditorFileBuffer(PATH, "a");
    await flushEditorBackups();
    expect(mocks.backups.has(KEY)).toBe(false);

    updateEditorFileBuffer(PATH, "ax");
    await settle();
    clearEditorFileBuffer(PATH);
    await flushEditorBackups();
    expect(mocks.backups.has(KEY)).toBe(false);
  });

  it("a change and a close inside the delay write nothing", async () => {
    mocks.disk.set(PATH, { content: "a", mtime: 1 });
    await readEditorFile(PATH);
    updateEditorFileBuffer(PATH, "ab");
    clearEditorFileBuffer(PATH);
    await settle();
    expect(mocks.backups.size).toBe(0);
  });

  it("puts the edits back on open, over an unchanged file, as unsaved", async () => {
    mocks.disk.set(PATH, { content: "a", mtime: 5 });
    mocks.backups.set(KEY, backupOf("a + edits", "a", 1));
    const { buffer, restored } = await openEditorFile(PATH);
    expect(restored).toBe(true);
    expect(buffer).toMatchObject({ content: "a + edits", savedContent: "a", mtime: 5, dirty: true });
    expect(getEditorFileBuffer(PATH)?.dirty).toBe(true);
  });

  it("over a file changed since, keeps the old mtime so the first save is a conflict", async () => {
    mocks.disk.set(PATH, { content: "someone else", mtime: 7 });
    mocks.backups.set(KEY, backupOf("mine", "old", 3));
    const { buffer } = await openEditorFile(PATH);
    expect(buffer).toMatchObject({ content: "mine", savedContent: "old", mtime: 3, dirty: true });
  });

  it("a file deleted since comes back deleted, holding the edits", async () => {
    mocks.backups.set(KEY, backupOf("mine", "old", 3));
    const { buffer, restored } = await openEditorFile(PATH);
    expect(restored).toBe(true);
    expect(buffer).toMatchObject({ content: "mine", deleted: true, dirty: true });
  });

  it("a copy equal to the disk is dropped, and no copy opens the file as usual", async () => {
    mocks.disk.set(PATH, { content: "same", mtime: 1 });
    mocks.backups.set(KEY, backupOf("same", "older"));
    expect((await openEditorFile(PATH)).restored).toBe(false);
    await flushEditorBackups();
    expect(mocks.backups.has(KEY)).toBe(false);

    clearEditorFileBuffer(PATH);
    const { buffer, restored } = await openEditorFile(PATH);
    expect(restored).toBe(false);
    expect(buffer.dirty).toBe(false);
  });

  it("a copy that cannot be read, or is not one, does not stop the file opening", async () => {
    mocks.disk.set(PATH, { content: "a", mtime: 1 });
    mocks.backupReadFails = true;
    expect((await openEditorFile(PATH)).buffer.content).toBe("a");

    clearEditorFileBuffer(PATH);
    mocks.backupReadFails = false;
    mocks.backups.set(KEY, "{torn");
    expect((await openEditorFile(PATH)).restored).toBe(false);
  });

  it("restoring a tab not shown reads the file only when it has a copy", async () => {
    mocks.disk.set(PATH, { content: "a", mtime: 1 });
    expect(await restoreEditorBackup(PATH)).toBeNull();
    expect(getEditorFileBuffer(PATH)).toBeNull();

    mocks.backups.set(KEY, backupOf("a!", "a"));
    expect((await restoreEditorBackup(PATH))?.buffer).toMatchObject({ content: "a!", dirty: true });
    // A file already open is left alone.
    expect(await restoreEditorBackup(PATH)).toBeNull();
  });

  it("a missing file with no copy still fails to open", async () => {
    await expect(openEditorFile(PATH)).rejects.toBeTruthy();
  });

  it("discarding drops every copy, written or still waiting", async () => {
    mocks.disk.set(PATH, { content: "a", mtime: 1 });
    mocks.disk.set("/repo/b.ts", { content: "b", mtime: 1 });
    await readEditorFile(PATH);
    await readEditorFile("/repo/b.ts");
    updateEditorFileBuffer(PATH, "a!");
    await settle();
    updateEditorFileBuffer("/repo/b.ts", "b!");
    await discardEditorBackups();
    await settle();
    expect(mocks.backups.size).toBe(0);
    clearEditorFileBuffer("/repo/b.ts");
  });

  it("keys a file by where it lives: the same path over SSH is another file", () => {
    expect(editorBackupKey(PATH)).not.toBe(editorBackupKey(PATH, { location: { kind: "ssh", host: "box" } }));
    expect(editorBackupKey(PATH, { location: { kind: "ssh", host: "box", user: "me", port: 2222 } }))
      .toBe(`ssh:me@box:2222\0${PATH}`);
  });
});
