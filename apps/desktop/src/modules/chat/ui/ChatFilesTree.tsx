"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { copyTextToClipboard } from "@/lib/clipboard";
import { formatShortcut } from "@/lib/hotkeys/format-shortcut";
import { isMacPlatform } from "@/lib/platform";
import { resolveWorkbenchFileIcon } from "@/modules/codespace/services/file-icon-theme";

import { absPath, treeIndex, type TreeEntry } from "../domain/files";
import { createChatEntry, renameChatEntry, revealChatFile, trashChatEntry } from "../runtime/chat-runtime-client";
import { Dither } from "./Dither";
import { beginFileDrag } from "./file-drag";
import { band, glow, MenuItem } from "./ThreadActions";

// Plan: plans/chat-files-tree/index.html (option B): icons, indent guides, keyboard, and a dither
// menu with new / rename / Move to Trash, drawn with the thread rail's menu, rename and confirm.

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** One row: a folder (chevron) or a file (its Code mode icon). `dir` is shown after a search hit's name. */
export function TreeRow({
  entry,
  dir,
  depth,
  open,
  changed,
  focusable = true,
  onClick,
  onContextMenu,
  onPointerDown,
}: {
  entry: TreeEntry;
  dir?: string;
  depth: number;
  open: boolean;
  changed: boolean;
  focusable?: boolean;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={entry.folder ? open : undefined}
      className="chat-files-row"
      data-folder={entry.folder || undefined}
      data-path={entry.path}
      tabIndex={focusable ? 0 : -1}
      style={{ paddingLeft: 10 + depth * 14 }}
      title={entry.path}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
    >
      {Array.from({ length: depth }, (_, d) => (
        <span key={d} className="chat-files-guide" style={{ left: 16 + d * 14 }} aria-hidden />
      ))}
      {entry.folder ? (
        <ChevronRight size={12} className="chat-files-chevron" aria-hidden />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a 14px bundled SVG; next/image adds nothing in a static export
        <img className="chat-files-icon" src={resolveWorkbenchFileIcon(entry.path).src} alt="" aria-hidden />
      )}
      <span className="chat-files-name">{entry.name}</span>
      {dir && <span className="chat-files-dir">{dir}</span>}
      {changed && <span className="chat-files-dot" aria-label="changed" />}
    </button>
  );
}

/** Naming in the tree: a new file or folder in `dir`, or a new name for `entry`. */
type Naming = { kind: "file" | "folder"; dir: string } | { kind: "rename"; entry: TreeEntry };

interface FilesTreeProps {
  cwd: string;
  files: readonly string[];
  changed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  setExpanded: (update: (set: ReadonlySet<string>) => ReadonlySet<string>) => void;
  /** `edit`: a file just made opens ready to type in. */
  onOpen: (path: string, edit?: boolean) => void;
  onMention?: (text: string) => void;
  /** Files were made, renamed or trashed: read the folder again. */
  onChanged: () => void;
  /** Browse only (a folder on another machine): no new, rename, trash or menu. */
  readOnly?: boolean;
  /** A file row drags onto the composer, attached by its path (a folder on another machine, ADR-0069). */
  dragToChat?: boolean;
}

export function FilesTree({ cwd, files, changed, expanded, setExpanded, onOpen, onMention, onChanged, readOnly = false, dragToChat = false }: FilesTreeProps) {
  // Folders made here that hold no file yet: the index lists files only.
  const [made, setMade] = useState<readonly string[]>([]);
  const tree = useMemo(() => treeIndex(files, made), [files, made]);
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ entry: TreeEntry; x: number; y: number } | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [trash, setTrash] = useState<TreeEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const visible: { entry: TreeEntry; depth: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of tree.get(dir) ?? []) {
      visible.push({ entry, depth });
      if (entry.folder && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  const byPath = new Map(visible.map((v) => [v.entry.path, v.entry]));
  const exists = (path: string) => files.includes(path) || tree.has(path);
  const current = focused !== null && byPath.has(focused) ? focused : (visible[0]?.entry.path ?? null);

  const focusRow = (path: string | undefined) => {
    if (path === undefined) return;
    setFocused(path);
    root.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
  };
  const toggle = (path: string, open?: boolean) =>
    setExpanded((set) => {
      const next = new Set(set);
      if (open ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  // A new entry goes into a folder, or beside a file.
  const startNew = (kind: "file" | "folder", at: TreeEntry | null) => {
    const dir = at ? (at.folder ? at.path : parentOf(at.path)) : "";
    if (dir) toggle(dir, true);
    setNaming({ kind, dir });
  };
  const act = (action: "mention" | "copy" | "reveal" | "file" | "folder" | "rename" | "trash", entry: TreeEntry) => {
    setMenu(null);
    if (action === "mention") onMention?.(`\`${entry.path}\` `);
    else if (action === "copy") void copyTextToClipboard(absPath(cwd, entry.path)).catch((reason: unknown) => setError(message(reason)));
    else if (action === "reveal") void revealChatFile(cwd, entry.path).catch((reason: unknown) => setError(message(reason)));
    else if (action === "file" || action === "folder") startNew(action, entry);
    else if (action === "rename") setNaming({ kind: "rename", entry });
    else setTrash(entry);
  };

  const submit = async (name: string) => {
    if (!naming) return;
    if (naming.kind === "rename") {
      const to = [parentOf(naming.entry.path), name].filter(Boolean).join("/");
      await renameChatEntry(cwd, naming.entry.path, to);
      setMade((dirs) => dirs.map((d) => (under(d, naming.entry.path) ? to + d.slice(naming.entry.path.length) : d)));
      setFocused(to);
    } else {
      // A trailing "/" makes a folder, whatever was asked for.
      const folder = naming.kind === "folder" || name.endsWith("/");
      const path = [naming.dir, name.replace(/\/+$/, "")].filter(Boolean).join("/");
      await createChatEntry(cwd, path, folder);
      if (folder) {
        setMade((dirs) => [...dirs, path]);
        setFocused(path);
      } else onOpen(path, true);
    }
    setNaming(null);
    onChanged();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.dataset.path) return;
    const path = event.target.dataset.path;
    const i = visible.findIndex((v) => v.entry.path === path);
    const entry = visible[i]?.entry;
    if (!entry) return;
    const key = event.key;
    if (key === "ArrowDown") focusRow(visible[i + 1]?.entry.path);
    else if (key === "ArrowUp") focusRow(visible[i - 1]?.entry.path);
    else if (key === "ArrowRight" && entry.folder) {
      if (expanded.has(path)) focusRow(visible[i + 1]?.depth === visible[i].depth + 1 ? visible[i + 1].entry.path : undefined);
      else toggle(path, true);
    } else if (key === "ArrowLeft") {
      if (entry.folder && expanded.has(path)) toggle(path, false);
      else focusRow(parentOf(path) || undefined);
    } else if (readOnly) return;
    else if (key === "Backspace" && event.metaKey) setTrash(entry);
    // Windows Explorer's keys: Delete trashes, F2 renames. ⌘⌫ above needs a key Windows lacks.
    else if (!isMacPlatform() && isBareKey(event, "Delete")) setTrash(entry);
    else if (!isMacPlatform() && isBareKey(event, "F2")) setNaming({ kind: "rename", entry });
    else if (event.metaKey || event.ctrlKey || event.altKey) return;
    else if (key === "n") startNew("file", entry);
    else if (key === "N") startNew("folder", entry);
    else if (key === "r") setNaming({ kind: "rename", entry });
    else if (key === "ContextMenu") {
      const box = event.target.getBoundingClientRect();
      setMenu({ entry, x: box.left + 24, y: box.bottom });
    } else return;
    event.preventDefault();
  };

  const field = (depth: number, dir: string, entry: TreeEntry | null) => (
    <NameField
      key="naming"
      depth={depth}
      dir={dir}
      entry={entry}
      folder={naming?.kind === "folder"}
      exists={exists}
      onSubmit={submit}
      onCancel={() => {
        setNaming(null);
        // Back to the row it started from, so the keyboard carries on.
        requestAnimationFrame(() => focusRow(current ?? undefined));
      }}
    />
  );
  const rows: ReactNode[] = [];
  // New in the root: the field comes first.
  if (naming && naming.kind !== "rename" && naming.dir === "") rows.push(field(0, "", null));
  for (const { entry, depth } of visible) {
    if (naming?.kind === "rename" && naming.entry.path === entry.path) {
      rows.push(field(depth, parentOf(entry.path), entry));
      continue;
    }
    rows.push(
      <TreeRow
        key={entry.path}
        entry={entry}
        depth={depth}
        open={expanded.has(entry.path)}
        changed={changed.has(entry.path)}
        focusable={entry.path === current}
        onClick={() => {
          setFocused(entry.path);
          if (entry.folder) toggle(entry.path);
          else onOpen(entry.path);
        }}
        onPointerDown={dragToChat && !entry.folder ? (event) => {
          const path = absPath(cwd, entry.path);
          // Already on the chat's machine: it goes by path, with no copy (decision 3).
          // shortcut: always a file, so an image is read by the agent, not drawn as a thumbnail here.
          beginFileDrag(event, { kind: "file", path, name: entry.name, mimeType: null, sizeBytes: null, remote: path });
        } : undefined}
        onContextMenu={readOnly ? undefined : (event) => {
          event.preventDefault();
          setFocused(entry.path);
          setMenu({ entry, x: event.clientX, y: event.clientY });
        }}
      />,
    );
    if (naming && naming.kind !== "rename" && entry.folder && naming.dir === entry.path) rows.push(field(depth + 1, entry.path, null));
  }

  return (
    <div ref={root} className="chat-files-tree" aria-label="Files" onKeyDown={onKeyDown}>
      {rows}
      {menu && (
        <FileMenu
          entry={menu.entry}
          at={{ x: menu.x, y: menu.y }}
          canMention={Boolean(onMention)}
          onAct={(action) => act(action, menu.entry)}
          onClose={() => {
            setMenu(null);
            focusRow(menu.entry.path);
          }}
        />
      )}
      {trash && (
        <TrashConfirm
          entry={trash}
          count={trash.folder ? files.filter((f) => under(f, trash.path)).length : 0}
          onCancel={() => {
            setTrash(null);
            focusRow(trash.path);
          }}
          onTrash={async () => {
            await trashChatEntry(cwd, trash.path);
            setMade((dirs) => dirs.filter((d) => !under(d, trash.path)));
            setTrash(null);
            onChanged();
          }}
        />
      )}
      {error && (
        <p className="chat-thread-error" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      )}
    </div>
  );
}

type FileAction = "mention" | "copy" | "reveal" | "file" | "folder" | "rename" | "trash";

function FileMenu({
  entry,
  at,
  canMention,
  onAct,
  onClose,
}: {
  entry: TreeEntry;
  at: { x: number; y: number };
  canMention: boolean;
  onAct: (action: FileAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // Kept on screen: a row near the bottom opens its menu upward.
    const { width, height } = menu.getBoundingClientRect();
    setPos({ x: Math.min(at.x, innerWidth - width - 8), y: Math.max(8, Math.min(at.y, innerHeight - height - 8)) });
    menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const outside = (event: PointerEvent) => !menu.contains(event.target as Node) && onClose();
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [at, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const key = event.key;
    if (key === "Escape" || key === "Tab") onClose();
    else if (key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else if (key === "@" && canMention) onAct("mention");
    else if (key === "c") onAct("copy");
    else if (key === "n") onAct("file");
    else if (key === "N") onAct("folder");
    else if (key === "r") onAct("rename");
    else if (key === "Backspace" || key === "Delete") onAct("trash");
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const dir = parentOf(entry.path);
  return createPortal(
    <div ref={ref} className="chat-thread-menu" role="menu" aria-label={`Actions for ${entry.path}`} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown}>
      {/* Names the entry, so you never rename or trash the wrong one. */}
      <div className="chat-thread-menu-head">
        <span className="chat-thread-menu-title">{entry.name}</span>
        <span className="chat-thread-menu-sub">{dir || "top level"}</span>
      </div>
      {canMention && <MenuItem label="Mention in chat" keycap="@" onClick={() => onAct("mention")} />}
      <MenuItem label="Copy path" keycap="C" onClick={() => onAct("copy")} />
      <MenuItem label="Reveal in Finder" keycap="" onClick={() => onAct("reveal")} />
      <hr className="chat-files-menu-rule" />
      <MenuItem label="New file" keycap="N" onClick={() => onAct("file")} />
      <MenuItem label="New folder" keycap={formatShortcut("⇧N")} onClick={() => onAct("folder")} />
      <MenuItem label="Rename" keycap={isMacPlatform() ? "R" : "F2"} onClick={() => onAct("rename")} />
      <hr className="chat-files-menu-rule" />
      <MenuItem label="Move to Trash" keycap={isMacPlatform() ? "⌘⌫" : "Del"} danger onClick={() => onAct("trash")} />
    </div>,
    document.body,
  );
}

/** `key` pressed on its own, with no modifier held. */
function isBareKey(event: KeyboardEvent<HTMLElement>, key: string): boolean {
  return event.key === key && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

/** The name before its extension: what a rename usually changes. */
function stemEnd(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

function NameField({
  depth,
  dir,
  entry,
  folder,
  exists,
  onSubmit,
  onCancel,
}: {
  depth: number;
  dir: string;
  entry: TreeEntry | null;
  folder: boolean;
  exists: (path: string) => boolean;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(entry?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const clean = name.trim().replace(/\/+$/, "");
  const target = [dir, clean].filter(Boolean).join("/");
  const same = entry !== null && clean === entry.name;
  // A case-only rename finds itself on a case-insensitive disk; Rust allows it.
  const clash = clean !== "" && !same && exists(target) && target.toLowerCase() !== entry?.path.toLowerCase();
  const problem = error ?? (clash ? `${clean} already exists in ${dir || "the top level"}` : null);

  const finish = async () => {
    if (done.current || busy) return;
    if (clean === "" || same) {
      done.current = true;
      onCancel();
      return;
    }
    if (clash) return;
    setBusy(true);
    try {
      done.current = true;
      await onSubmit(name.trim());
    } catch (reason) {
      done.current = false;
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-thread-rename chat-files-naming" data-error={problem ? "" : undefined} style={{ marginLeft: 10 + depth * 14 }}>
      <input
        className="chat-thread-rename-input"
        aria-label={entry ? `New name for ${entry.name}` : folder ? "New folder name" : "New file name"}
        aria-invalid={problem ? true : undefined}
        value={name}
        placeholder={folder ? "folder name" : "file name"}
        disabled={busy}
        autoFocus
        spellCheck={false}
        onFocus={(event) => event.currentTarget.setSelectionRange(0, entry ? stemEnd(entry.name) : 0)}
        onChange={(event) => {
          setError(null);
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void finish();
          else if (event.key === "Escape") {
            done.current = true;
            onCancel();
          } else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        // Clicking away cancels, as Esc does: nothing is made or renamed by accident.
        onBlur={() => {
          if (done.current || busy) return;
          done.current = true;
          onCancel();
        }}
      />
      <Dither className="chat-thread-rename-line" field={band} cell={1} />
      <span className="chat-thread-rename-hint" role={problem ? "alert" : undefined}>
        {problem ?? (
          <>
            <kbd>↵</kbd> {entry ? "save" : "create"} <kbd>esc</kbd> cancel
            {!entry && !folder && " · end with / for a folder"}
          </>
        )}
      </span>
    </div>
  );
}

function TrashConfirm({ entry, count, onCancel, onTrash }: { entry: TreeEntry; count: number; onCancel: () => void; onTrash: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    setBusy(true);
    setError(null);
    onTrash().catch((reason: unknown) => {
      setBusy(false);
      setError(message(reason));
    });
  };
  const what = entry.folder && count > 0 ? `“${entry.name}” and its ${count} ${count === 1 ? "file" : "files"}` : `“${entry.name}”`;
  return createPortal(
    <div className="chat-thread-scrim" onPointerDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <div
        className="chat-thread-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="chat-files-trash-title"
        aria-describedby="chat-files-trash-body"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
          // Two buttons; Tab stays between them.
          if (event.key === "Tab") {
            const buttons = [...event.currentTarget.querySelectorAll("button")];
            buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + 1) % buttons.length]?.focus();
            event.preventDefault();
          }
          event.stopPropagation();
        }}
      >
        <Dither className="chat-thread-confirm-glow" field={glow} />
        <h2 id="chat-files-trash-title" className="chat-thread-confirm-title">
          Move {what} to Trash?
        </h2>
        <p id="chat-files-trash-body" className="chat-thread-confirm-body">
          {error ?? <>{entry.path} · you can put it back from the Trash in Finder.</>}
        </p>
        <div className="chat-thread-confirm-actions">
          <button type="button" className="chat-thread-confirm-cancel" autoFocus disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="chat-thread-confirm-delete" disabled={busy} onClick={run}>
            {busy ? "Moving…" : "Move to Trash"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
