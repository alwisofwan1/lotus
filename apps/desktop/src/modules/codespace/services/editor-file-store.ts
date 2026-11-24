"use client";

import { editorReadFile, editorWriteFile } from "@/lib/tauri-api";
import {
  editorReadFileBytes,
  editorReadFileBytesFor,
  editorReadFileFor,
  editorWriteFileFor,
  type CodeSpaceStoredWorkspaceLocation,
} from "@/lib/tauri/codespace";
import { parseRemoteError } from "@/lib/tauri/remote-error";

export type EditorFileBuffer = {
  path: string;
  content: string;
  savedContent?: string;
  mtime: number;
  sizeBytes: number;
  binary: boolean;
  dirty: boolean;
  /** How the file is stored on disk (`editor_encoding.rs` ids); a save writes it back so. */
  encoding?: string;
  /** Not read because of its size; "Open anyway" reads it (`allowLargeEditorFile`). */
  tooLarge?: boolean;
  /** Gone from disk while open. The text stays; a save puts the file back. */
  deleted?: boolean;
  /** The text a save is writing right now: the watcher's echo of it is not someone else's change. */
  pendingWrite?: string;
};

export type EditorFileIoContext = {
  location?: CodeSpaceStoredWorkspaceLocation | null;
  rootDir?: string | null;
};

/** "Open anyway" reads a large file up to this size (`MAX_EDITOR_LARGE_FILE_SIZE_BYTES`). */
export const EDITOR_LARGE_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

const BUFFERS = new Map<string, EditorFileBuffer>();

/*
 * How many files hold unsaved edits, for whoever must not let them go silently: closing the
 * window, quitting the app. Told only when the number changes.
 */
type UnsavedListener = (count: number) => void;
const UNSAVED_LISTENERS = new Set<UnsavedListener>();
let lastUnsavedCount = 0;

export function countUnsavedEditorFiles(): number {
  let count = 0;
  for (const buffer of BUFFERS.values()) if (buffer.dirty) count += 1;
  return count;
}

export function onUnsavedEditorFilesChange(listener: UnsavedListener): () => void {
  UNSAVED_LISTENERS.add(listener);
  return () => UNSAVED_LISTENERS.delete(listener);
}

function notifyUnsavedChange(): void {
  const count = countUnsavedEditorFiles();
  if (count === lastUnsavedCount) return;
  lastUnsavedCount = count;
  for (const listener of UNSAVED_LISTENERS) listener(count);
}

/*
 * Every change to a buffer, with where its file lives, for the hot-exit backups
 * (`editor-backups.ts`): `null` when the buffer is gone.
 */
type BufferChangeListener = (path: string, buffer: EditorFileBuffer | null, context: EditorFileIoContext) => void;
const CHANGE_LISTENERS = new Set<BufferChangeListener>();
/** Where each buffer's file is read from and saved to: the workspace location and root. */
const CONTEXTS = new Map<string, EditorFileIoContext>();

export function onEditorFileBufferChange(listener: BufferChangeListener): () => void {
  CHANGE_LISTENERS.add(listener);
  return () => CHANGE_LISTENERS.delete(listener);
}

function setBuffer(path: string, buffer: EditorFileBuffer): void {
  BUFFERS.set(path, buffer);
  notifyUnsavedChange();
  const context = CONTEXTS.get(path) ?? {};
  for (const listener of CHANGE_LISTENERS) listener(path, buffer, context);
}

/*
 * A file no pane holds any more. The Monaco model for it (one per path, kept so a reopened tab
 * keeps its undo history) is freed by whoever listens; without this, every file ever opened kept
 * its full text in memory for the rest of the session.
 */
type ReleasedListener = (path: string) => void;
const RELEASED_LISTENERS = new Set<ReleasedListener>();

export function onEditorFileBufferReleased(listener: ReleasedListener): () => void {
  RELEASED_LISTENERS.add(listener);
  return () => RELEASED_LISTENERS.delete(listener);
}

function deleteBuffer(path: string): void {
  BUFFERS.delete(path);
  notifyUnsavedChange();
  const context = CONTEXTS.get(path) ?? {};
  CONTEXTS.delete(path);
  for (const listener of CHANGE_LISTENERS) listener(path, null, context);
  for (const listener of RELEASED_LISTENERS) listener(path);
}

function getBuffer(path: string): EditorFileBuffer | null {
  return BUFFERS.get(path) ?? null;
}

/** Local reads fail with the OS text; remote ones carry a code. */
export function isMissingEditorFileError(err: unknown): boolean {
  const parsed = parseRemoteError(err);
  if (parsed.code === "NOT_FOUND") return true;
  return parsed.code === "OTHER" && /No such file or directory|os error 2\b/i.test(parsed.message);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function relativePathFromRoot(rootDir: string | null | undefined, path: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(rootDir?.trim() ?? "").replace(/\/+$/, "");
  const isInsideRoot = normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
  if (!normalizedRoot || !isInsideRoot) {
    return normalizedPath.replace(/^[/\\]+/, "");
  }
  return normalizedPath.slice(normalizedRoot.length).replace(/^[/\\]+/, "") || normalizedPath;
}

/*
 * Where a read or write goes. Inside the workspace root: the root plus the path below it, over
 * SSH when the workspace is remote. An absolute path OUTSIDE the root (a Thread link into a
 * sibling repo, say) used to lose its leading `/` and be joined onto the root — another file, or
 * "not found". Now it is read where it is: by its own path locally, and on SSH from its own
 * folder (the remote scripts refuse anything outside the root they are given).
 */
type IoRoute =
  | { kind: "path"; path: string }
  | { kind: "rooted"; location: CodeSpaceStoredWorkspaceLocation | null; root: string | undefined; relative: string };

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function ioRoute(path: string, context: EditorFileIoContext): IoRoute {
  if (!context.location && !context.rootDir) return { kind: "path", path };
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(context.rootDir?.trim() ?? "").replace(/\/+$/, "");
  const insideRoot = Boolean(normalizedRoot) && normalizedPath.startsWith(`${normalizedRoot}/`);
  if (!insideRoot && isAbsolutePath(normalizedPath)) {
    if (context.location?.kind !== "ssh") return { kind: "path", path };
    const slash = normalizedPath.lastIndexOf("/");
    return {
      kind: "rooted",
      location: context.location,
      root: normalizedPath.slice(0, slash) || "/",
      relative: normalizedPath.slice(slash + 1),
    };
  }
  return {
    kind: "rooted",
    location: context.location ?? null,
    root: context.rootDir ?? undefined,
    relative: relativePathFromRoot(context.rootDir, path),
  };
}

const rootOptions = (root: string | undefined) => ({ localRoot: root, remoteRoot: root });

export type DiskFile = Pick<EditorFileBuffer, "content" | "mtime" | "sizeBytes" | "binary" | "encoding" | "tooLarge">;

/*
 * Files the user chose to open past the 10 MB text cap. Every later read of them (a reload, the
 * watcher's re-read) asks for the large cap too, or the open file would turn back into
 * "too large" on its first change on disk.
 */
const LARGE_ALLOWED = new Set<string>();

export function allowLargeEditorFile(path: string): void {
  LARGE_ALLOWED.add(path);
}

/**
 * The text as Monaco will hold it. A file with mixed line endings is normalised by Monaco to the
 * one most lines use, so the model never equalled the text read from disk: it opened dirty, and
 * `applyExternalContent` kept pushing the mixed text back. The same rule here (Monaco's
 * `PieceTreeTextBufferBuilder`: CRLF when more than half the breaks have a CR) keeps them equal.
 * Saving writes the normalised text, as VS Code does.
 */
export function normalizeMixedLineEndings(text: string): string {
  let crlf = 0;
  let cr = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (code === 10) {
      lf += 1;
    }
  }
  const total = crlf + cr + lf;
  if (total === 0) return text;
  const eol = cr + crlf > total / 2 ? "\r\n" : "\n";
  const mixed = eol === "\r\n" ? cr > 0 || lf > 0 : cr > 0 || crlf > 0;
  return mixed ? text.replace(/\r\n|\r|\n/g, eol) : text;
}

/** The file as it is on disk now, without touching its buffer (Compare reads it this way). */
export async function readDiskFile(
  path: string,
  context: EditorFileIoContext = {},
): Promise<DiskFile> {
  const route = ioRoute(path, context);
  const allowLarge = LARGE_ALLOWED.has(path) || undefined;
  const result = route.kind === "rooted"
    ? await editorReadFileFor(route.location, route.relative, { ...rootOptions(route.root), allowLarge })
    : await editorReadFile(route.path, { allowLarge });
  return result.binary ? result : { ...result, content: normalizeMixedLineEndings(result.content) };
}

/** The file's raw bytes, for the media viewer. Never touches its buffer. */
export async function readEditorFileBytes(
  path: string,
  context: EditorFileIoContext = {},
): Promise<ArrayBuffer> {
  const route = ioRoute(path, context);
  return route.kind === "rooted"
    ? await editorReadFileBytesFor(route.location, route.relative, rootOptions(route.root))
    : await editorReadFileBytes(route.path);
}

/** Reads the file into its buffer, replacing what the buffer held. */
export async function readEditorFile(
  path: string,
  context: EditorFileIoContext = {},
): Promise<EditorFileBuffer> {
  const result = await readDiskFile(path, context);
  const buffer: EditorFileBuffer = {
    path,
    content: result.content,
    savedContent: result.content,
    mtime: result.mtime,
    sizeBytes: result.sizeBytes,
    binary: result.binary,
    encoding: result.encoding,
    tooLarge: result.tooLarge,
    dirty: false,
  };
  CONTEXTS.set(path, context);
  setBuffer(path, buffer);
  return buffer;
}

/** A buffer made elsewhere (unsaved edits put back from a hot-exit backup) becomes the file's. */
export function putEditorFileBuffer(buffer: EditorFileBuffer, context: EditorFileIoContext = {}): void {
  CONTEXTS.set(buffer.path, context);
  setBuffer(buffer.path, buffer);
}

/**
 * The file was not found on disk while open (the watcher saw it go). The tab keeps its text and
 * says so; a save puts the file back. Returns whether this changed anything.
 */
export function markEditorFileDeleted(path: string): boolean {
  const buffer = BUFFERS.get(path);
  if (!buffer || buffer.deleted) return false;
  setBuffer(path, { ...buffer, deleted: true });
  return true;
}

export function getEditorFileBuffer(path: string): EditorFileBuffer | null {
  return getBuffer(path);
}

export function updateEditorFileBuffer(path: string, content: string): EditorFileBuffer | null {
  const existing = BUFFERS.get(path);
  if (!existing || existing.binary) return existing ?? null;
  const next: EditorFileBuffer = {
    ...existing,
    content,
    dirty: content !== (existing.savedContent ?? existing.content),
  };
  setBuffer(path, next);
  return next;
}

/** Throws the unsaved edits away for the disk copy: Reload from disk. */
export function reloadEditorFile(path: string, context: EditorFileIoContext = {}): Promise<EditorFileBuffer> {
  return readEditorFile(path, context);
}

export type DiskSyncResult = "unchanged" | "reloaded" | "conflict";

/**
 * The file changed on disk while open: what its buffer does about it. Synchronous on purpose —
 * the caller reads the disk first, and the decision is made against the buffer as it is after
 * that read, so a key typed meanwhile turns a reload into a conflict instead of being lost.
 */
export function applyDiskFile(path: string, disk: DiskFile): DiskSyncResult {
  const buffer = BUFFERS.get(path);
  if (!buffer) return "unchanged";
  if (buffer.binary) {
    // Nothing to merge in a binary file: a new mtime or size means new bytes for the viewer.
    if (disk.mtime === buffer.mtime && disk.sizeBytes === buffer.sizeBytes && !buffer.deleted) return "unchanged";
    setBuffer(path, { ...buffer, ...disk, savedContent: disk.content, dirty: false, deleted: false });
    return "reloaded";
  }
  // Our own save, landing before its result came back: the save sets the mtime when it does.
  if (buffer.pendingWrite !== undefined && disk.content === buffer.pendingWrite) return "unchanged";
  const saved = buffer.savedContent ?? buffer.content;
  if (disk.content === saved || disk.content === buffer.content) {
    // Our own save coming back, a touch, or someone saving exactly these edits: same text, so
    // only the mtime moves (and a buffer that now matches the disk is clean).
    setBuffer(path, {
      ...buffer,
      mtime: disk.mtime,
      savedContent: disk.content,
      dirty: buffer.content !== disk.content,
      deleted: false,
    });
    return "unchanged";
  }
  if (buffer.dirty) return "conflict";
  setBuffer(path, {
    ...buffer,
    content: disk.content,
    savedContent: disk.content,
    mtime: disk.mtime,
    sizeBytes: disk.sizeBytes,
    binary: disk.binary,
    encoding: disk.encoding,
    tooLarge: disk.tooLarge,
    deleted: false,
    dirty: false,
  });
  return "reloaded";
}

/** The write was refused because the file changed on disk since it was read. */
export function isSaveConflict(err: unknown): boolean {
  const parsed = parseRemoteError(err);
  return parsed.code === "MTIME_CONFLICT"
    || (parsed.code === "OTHER" && /File has changed on disk/i.test(parsed.message));
}

export type SaveOptions = {
  /** Write even though the file changed on disk: skips the mtime check for this one save. */
  overwrite?: boolean;
};

/*
 * One save at a time per file. A second ⌘S while the first write ran sent the mtime from before
 * that write, so the backend saw a changed file and the user got a false "changed on disk"
 * conflict. A save that arrives during another waits for it, then writes only if there is still
 * something to write.
 */
const SAVES_IN_FLIGHT = new Map<string, Promise<EditorFileBuffer | null>>();

export function saveEditorFile(
  path: string,
  context: EditorFileIoContext = {},
  options: SaveOptions = {},
): Promise<EditorFileBuffer | null> {
  const previous = SAVES_IN_FLIGHT.get(path);
  const run = previous
    ? previous.catch(() => null).then(() => {
      const buffer = BUFFERS.get(path);
      return buffer && !buffer.dirty && !options.overwrite ? buffer : writeEditorFile(path, context, options);
    })
    : writeEditorFile(path, context, options);
  SAVES_IN_FLIGHT.set(path, run);
  const settle = () => {
    if (SAVES_IN_FLIGHT.get(path) === run) SAVES_IN_FLIGHT.delete(path);
  };
  run.then(settle, settle);
  return run;
}

async function writeEditorFile(
  path: string,
  context: EditorFileIoContext,
  options: SaveOptions,
): Promise<EditorFileBuffer | null> {
  const existing = BUFFERS.get(path);
  if (!existing || existing.binary) return existing ?? null;
  const expectedMtime = options.overwrite ? undefined : existing.mtime;
  setBuffer(path, { ...existing, pendingWrite: existing.content });
  let result;
  try {
    const route = ioRoute(path, context);
    result = route.kind === "rooted"
      ? await editorWriteFileFor(route.location, route.relative, existing.content, expectedMtime, {
        ...rootOptions(route.root),
        encoding: existing.encoding,
      })
      : await editorWriteFile(route.path, existing.content, expectedMtime, existing.encoding);
  } catch (error) {
    const current = BUFFERS.get(path);
    if (current) setBuffer(path, { ...current, pendingWrite: undefined });
    throw error;
  }
  // Keys typed while the write ran are in the buffer now; keep them, and stay dirty for them.
  const current = BUFFERS.get(path) ?? existing;
  const next: EditorFileBuffer = {
    ...current,
    pendingWrite: undefined,
    mtime: result.mtime,
    savedContent: existing.content,
    dirty: current.content !== existing.content,
    deleted: false,
  };
  setBuffer(path, next);
  return next;
}

/** Throws the buffer away for every pane: git discarded the edits, so no pane may keep them. */
export function clearEditorFileBuffer(path: string): void {
  deleteBuffer(path);
}

/*
 * Which panes have which files open. Buffers are shared — two panes on one file edit one buffer,
 * as they share one Monaco model — so a pane closing its tab must not throw away a buffer
 * another pane still shows: that pane's next keys would land nowhere and ⌘S would save nothing.
 */
const HOLDERS = new Map<string, ReadonlySet<string>>();

/** The files a pane has open now (its file tabs). Called whenever its tabs change. */
export function setEditorFileHolder(holderId: string, paths: Iterable<string>): void {
  HOLDERS.set(holderId, new Set(paths));
}

/** Another pane has the file open too: closing it here loses nothing, the edits live on there. */
export function heldByAnotherPane(path: string, holderId: string): boolean {
  for (const [id, paths] of HOLDERS) {
    if (id !== holderId && paths.has(path)) return true;
  }
  return false;
}

/** One pane is done with the file (its tab closed): the buffer goes once no pane holds it. */
export function releaseEditorFileBuffer(path: string, holderId: string): void {
  const held = HOLDERS.get(holderId);
  if (held?.has(path)) HOLDERS.set(holderId, new Set([...held].filter((item) => item !== path)));
  if (!heldByAnotherPane(path, holderId)) clearEditorFileBuffer(path);
}

/** The pane itself closed: every file it held is released. */
export function releaseEditorFileHolder(holderId: string, paths: Iterable<string> = []): void {
  const held = new Set([...(HOLDERS.get(holderId) ?? []), ...paths]);
  HOLDERS.delete(holderId);
  for (const path of held) {
    if (!heldByAnotherPane(path, holderId)) clearEditorFileBuffer(path);
  }
}

/** After a rename: the buffer at `from`, and every buffer under it when it was a folder. */
export function moveEditorFileBuffers(from: string, to: string): void {
  const base = normalizePath(from).replace(/\/+$/, "");
  for (const [path, buffer] of [...BUFFERS]) {
    const normalized = normalizePath(path);
    if (normalized !== base && !normalized.startsWith(`${base}/`)) continue;
    const next = `${to}${normalized.slice(base.length)}`;
    if (LARGE_ALLOWED.delete(path)) LARGE_ALLOWED.add(next);
    const context = CONTEXTS.get(path);
    deleteBuffer(path);
    if (context) CONTEXTS.set(next, context);
    setBuffer(next, { ...buffer, path: next });
  }
}

export function getEditorFileBuffers(): EditorFileBuffer[] {
  return Array.from(BUFFERS.values());
}
