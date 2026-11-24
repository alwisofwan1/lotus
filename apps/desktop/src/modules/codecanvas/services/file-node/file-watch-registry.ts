import type { EditorReadFileResult, CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import type { EditorFsChange } from "@/lib/tauri/editor-watch";
import { isMissingEditorFileError } from "@/modules/codespace/services/editor-file-store";

/**
 * What a File Node shows for its file. `rev` counts fresh reads of the path, so a consumer that
 * derives something from the text (the git baseline) can tell "same content, read again after a
 * git move" from "nothing happened".
 */
export type FileView =
  | { status: "loading" }
  | { status: "ready"; content: string; sizeBytes: number; mtime: number; rev: number }
  | { status: "binary"; sizeBytes: number }
  | { status: "too-large"; sizeBytes: number }
  | { status: "missing" }
  | { status: "error"; message: string };

export interface FileSource {
  /** The canvas project root: one watch per root. */
  root: string;
  /** null = this machine. */
  location: CodeSpaceStoredWorkspaceLocation | null;
  /** Absolute, `/`-separated. */
  path: string;
}

/** What a read must give for a view; the editor's disk read and the raw read both carry it. */
export type FileRead = Pick<EditorReadFileResult, "content" | "mtime" | "sizeBytes" | "binary" | "tooLarge">;

export interface FileWatchDeps {
  read: (root: string, location: CodeSpaceStoredWorkspaceLocation | null, path: string) => Promise<FileRead>;
  watch: (root: string, onChange: (change: EditorFsChange) => void) => () => void;
  onWindowFocus: (callback: () => void) => () => void;
}

type Listener = (view: FileView) => void;

interface Entry {
  source: FileSource;
  view: FileView;
  listeners: Set<Listener>;
  /** Guards against an older read landing after a newer one. */
  token: number;
  rev: number;
}

interface RootWatch {
  entries: Map<string, Entry>;
  stop: (() => void) | null;
}

function classify(result: FileRead, rev: number): FileView {
  if (result.binary && result.tooLarge) return { status: "too-large", sizeBytes: result.sizeBytes };
  if (result.binary) return { status: "binary", sizeBytes: result.sizeBytes };
  return { status: "ready", content: result.content, sizeBytes: result.sizeBytes, mtime: result.mtime, rev };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Could not read this file.";
}

/**
 * ONE watch per canvas root, shared by every File Node on the board (plans/canvas-code, S3).
 *
 * `subscribe(source, listener)` returns the unsubscribe. Nodes on the same path share one read and
 * one state; the root's watch starts with its first subscriber and stops with its last, so a node
 * that collapses to a glyph (and unsubscribes) costs nothing. A remote root is never watched: its
 * paths re-read on window focus instead, matching CodeSpace's SSH behaviour.
 */
export function createFileWatchRegistry(deps: FileWatchDeps) {
  const roots = new Map<string, RootWatch>();
  let stopFocus: (() => void) | null = null;

  const isRemote = (source: FileSource) => source.location?.kind === "ssh";
  const rootKey = (source: FileSource) => `${isRemote(source) ? "ssh" : "local"}\u0000${source.root}`;

  function publish(entry: Entry, view: FileView) {
    entry.view = view;
    for (const listener of [...entry.listeners]) listener(view);
  }

  async function load(entry: Entry): Promise<void> {
    const token = ++entry.token;
    try {
      const result = await deps.read(entry.source.root, entry.source.location, entry.source.path);
      if (token !== entry.token || entry.listeners.size === 0) return;
      entry.rev += 1;
      publish(entry, classify(result, entry.rev));
    } catch (error) {
      if (token !== entry.token || entry.listeners.size === 0) return;
      publish(entry, isMissingEditorFileError(error) ? { status: "missing" } : { status: "error", message: errorMessage(error) });
    }
  }

  function refreshAll(root: RootWatch) {
    for (const entry of root.entries.values()) void load(entry);
  }

  function ensureFocusHook() {
    if (stopFocus) return;
    stopFocus = deps.onWindowFocus(() => {
      for (const root of roots.values()) {
        const first = root.entries.values().next().value as Entry | undefined;
        if (first && isRemote(first.source)) refreshAll(root);
      }
    });
  }

  function releaseFocusHookIfIdle() {
    const anyRemote = [...roots.values()].some((root) => {
      const first = root.entries.values().next().value as Entry | undefined;
      return first && isRemote(first.source);
    });
    if (anyRemote || !stopFocus) return;
    stopFocus();
    stopFocus = null;
  }

  function subscribe(source: FileSource, listener: Listener): () => void {
    const key = rootKey(source);
    let root = roots.get(key);
    if (!root) {
      root = { entries: new Map(), stop: null };
      roots.set(key, root);
      if (isRemote(source)) {
        ensureFocusHook();
      } else {
        const created = root;
        created.stop = deps.watch(source.root, (change) => {
          if (change.overflow || change.git) {
            refreshAll(created);
            return;
          }
          for (const path of change.paths) {
            const entry = created.entries.get(path);
            if (entry) void load(entry);
          }
        });
      }
    }
    const group = root;
    let entry = group.entries.get(source.path);
    const fresh = !entry;
    if (!entry) {
      entry = { source, view: { status: "loading" }, listeners: new Set(), token: 0, rev: 0 };
      group.entries.set(source.path, entry);
    }
    const target = entry;
    target.listeners.add(listener);
    listener(target.view);
    if (fresh) void load(target);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      target.listeners.delete(listener);
      if (target.listeners.size > 0) return;
      target.token += 1;
      group.entries.delete(source.path);
      if (group.entries.size > 0) return;
      group.stop?.();
      roots.delete(key);
      releaseFocusHookIfIdle();
    };
  }

  return { subscribe };
}

export type FileWatchRegistry = ReturnType<typeof createFileWatchRegistry>;
