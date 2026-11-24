"use client";

/*
 * Hot exit: every unsaved buffer is copied to disk (`editor_backup.rs`) a moment after its last
 * change, and the copy goes when the buffer is saved, reverted or discarded. A crash, a force
 * quit or a power cut used to lose every unsaved edit; now the next open of the file puts them
 * back as unsaved edits, and says so.
 *
 * The copy holds the saved text too. When the file changed on disk after the copy was made,
 * the edits come back against the text they were made on, with its mtime: the first save is
 * then refused as "changed on disk", and the conflict banner offers Compare, Reload, Overwrite.
 * Nothing on disk is written over without the user seeing it.
 */

import { editorBackupDelete, editorBackupRead, editorBackupWrite } from "@/lib/tauri/codespace";
import {
  getEditorFileBuffer,
  isMissingEditorFileError,
  onEditorFileBufferChange,
  putEditorFileBuffer,
  readEditorFile,
  type EditorFileBuffer,
  type EditorFileIoContext,
} from "@/modules/codespace/services/editor-file-store";

/** How long after the last change a buffer is copied: typing writes one copy per pause. */
export const EDITOR_BACKUP_DELAY_MS = 1000;

type BackupData = {
  v: 1;
  path: string;
  content: string;
  savedContent: string;
  mtime: number;
  encoding?: string;
  savedAt: number;
};

/** One key per file per machine: the same path on the Mac and on an SSH host are two files. */
export function editorBackupKey(path: string, context: EditorFileIoContext = {}): string {
  const location = context.location;
  const where = location?.kind === "ssh"
    ? `ssh:${location.user ? `${location.user}@` : ""}${location.host}:${location.port ?? 22}`
    : "local";
  return `${where}\0${path}`;
}

const TIMERS = new Map<string, { timer: ReturnType<typeof setTimeout>; path: string }>();
/** Keys with a copy on disk now, as far as this window knows. */
const ON_DISK = new Set<string>();
/** Keys whose buffer was unsaved at its last change. */
const DIRTY = new Set<string>();
/** Writes and deletes per key, in order: a delete must not land before the write it follows. */
const QUEUES = new Map<string, Promise<void>>();

function enqueue(key: string, op: () => Promise<void>): Promise<void> {
  const next = (QUEUES.get(key) ?? Promise.resolve()).then(op).catch((error: unknown) => {
    console.warn("[editor] hot-exit backup failed:", error);
  });
  QUEUES.set(key, next);
  void next.then(() => {
    if (QUEUES.get(key) === next) QUEUES.delete(key);
  });
  return next;
}

function cancelTimer(key: string): void {
  const pending = TIMERS.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  TIMERS.delete(key);
}

function writeNow(key: string, path: string): void {
  TIMERS.delete(key);
  const buffer = getEditorFileBuffer(path);
  if (!buffer?.dirty || buffer.binary) return;
  const data: BackupData = {
    v: 1,
    path,
    content: buffer.content,
    savedContent: buffer.savedContent ?? buffer.content,
    mtime: buffer.mtime,
    encoding: buffer.encoding,
    savedAt: Date.now(),
  };
  ON_DISK.add(key);
  void enqueue(key, () => editorBackupWrite(key, JSON.stringify(data)));
}

function dropBackup(key: string): Promise<void> {
  cancelTimer(key);
  if (!ON_DISK.delete(key)) return QUEUES.get(key) ?? Promise.resolve();
  return enqueue(key, () => editorBackupDelete(key));
}

function onChange(path: string, buffer: EditorFileBuffer | null, context: EditorFileIoContext): void {
  const key = editorBackupKey(path, context);
  if (buffer?.dirty && !buffer.binary) {
    DIRTY.add(key);
    cancelTimer(key);
    TIMERS.set(key, { timer: setTimeout(() => writeNow(key, path), EDITOR_BACKUP_DELAY_MS), path });
    return;
  }
  // Saved, typed back to the saved text, reloaded, discarded or closed: the copy goes.
  if (DIRTY.delete(key) || ON_DISK.has(key) || TIMERS.has(key)) void dropBackup(key);
}

let users = 0;
let stopListening: (() => void) | null = null;

/** Starts copying unsaved buffers; one call per window is enough, extra calls are counted. */
export function startEditorBackups(): () => void {
  users += 1;
  if (users === 1) stopListening = onEditorFileBufferChange(onChange);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    users -= 1;
    if (users === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

/** Writes every pending copy now (the window is going away, and the timers go with it). */
export function flushEditorBackups(): Promise<void> {
  for (const [key, { path }] of [...TIMERS]) writeNow(key, path);
  return Promise.all([...QUEUES.values()]).then(() => {});
}

/**
 * The user chose to lose the unsaved edits (closing the window or quitting "without saving"):
 * their copies go too, or the next start would bring back what was thrown away.
 */
export function discardEditorBackups(): Promise<void> {
  // Every unsaved buffer passed through `onChange` on its way to unsaved, so DIRTY has its key.
  const keys = new Set([...TIMERS.keys(), ...ON_DISK, ...DIRTY]);
  return Promise.all([...keys].map((key) => {
    DIRTY.delete(key);
    ON_DISK.add(key);
    return dropBackup(key);
  })).then(() => {});
}

function parseBackup(raw: string | null, path: string): BackupData | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<BackupData>;
    if (data.v !== 1 || data.path !== path) return null;
    if (typeof data.content !== "string" || typeof data.savedContent !== "string") return null;
    if (typeof data.mtime !== "number") return null;
    return data as BackupData;
  } catch {
    return null;
  }
}

export type OpenedEditorFile = {
  buffer: EditorFileBuffer;
  /** Unsaved edits from an earlier run were put back. */
  restored: boolean;
};

/**
 * Reads the file into its buffer, as `readEditorFile`, and puts back the unsaved edits a backup
 * holds for it. A file deleted on disk since comes back as a deleted file holding the edits.
 */
export async function openEditorFile(path: string, context: EditorFileIoContext = {}): Promise<OpenedEditorFile> {
  const key = editorBackupKey(path, context);
  // A backup that cannot be read is no backup: the file still opens.
  const backupRead = Promise.resolve()
    .then(() => editorBackupRead(key))
    .then((raw) => parseBackup(raw, path), () => null);
  let disk: EditorFileBuffer | null = null;
  let readError: unknown = null;
  try {
    disk = await readEditorFile(path, context);
  } catch (error) {
    readError = error;
  }
  const backup = await backupRead;
  if (!disk) {
    // Unreachable (an SSH host offline): keep the copy for when it can be read.
    if (!backup || !isMissingEditorFileError(readError)) throw readError;
    const buffer: EditorFileBuffer = {
      path,
      content: backup.content,
      savedContent: backup.savedContent,
      mtime: backup.mtime,
      sizeBytes: 0,
      binary: false,
      encoding: backup.encoding,
      deleted: true,
      dirty: true,
    };
    ON_DISK.add(key);
    putEditorFileBuffer(buffer, context);
    return { buffer, restored: true };
  }
  if (!backup) return { buffer: disk, restored: false };
  if (disk.binary || disk.tooLarge || backup.content === disk.content) {
    ON_DISK.add(key);
    await dropBackup(key);
    return { buffer: disk, restored: false };
  }
  const unchangedOnDisk = disk.content === backup.savedContent;
  const buffer: EditorFileBuffer = {
    ...disk,
    content: backup.content,
    savedContent: unchangedOnDisk ? disk.content : backup.savedContent,
    mtime: unchangedOnDisk ? disk.mtime : backup.mtime,
    dirty: true,
  };
  ON_DISK.add(key);
  putEditorFileBuffer(buffer, context);
  return { buffer, restored: true };
}

/**
 * A tab that is open but not shown has no buffer until it is clicked: its edits would wait on
 * disk, unseen and not counted by the close and quit questions. A pane calls this for each of
 * its file tabs when it starts; only a file that has a backup is read.
 */
export async function restoreEditorBackup(path: string, context: EditorFileIoContext = {}): Promise<OpenedEditorFile | null> {
  if (getEditorFileBuffer(path)) return null;
  const raw = await Promise.resolve()
    .then(() => editorBackupRead(editorBackupKey(path, context)))
    .catch(() => null);
  if (!parseBackup(raw, path) || getEditorFileBuffer(path)) return null;
  const opened = await openEditorFile(path, context);
  return opened.restored ? opened : null;
}

/** For tests: forget every timer and key. */
export function resetEditorBackupsForTest(): void {
  for (const { timer } of TIMERS.values()) clearTimeout(timer);
  TIMERS.clear();
  ON_DISK.clear();
  DIRTY.clear();
  QUEUES.clear();
}
