"use client";

import { ArrowUpRight, ChevronLeft, Ellipsis, ExternalLink, Pencil } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { copyTextToClipboard } from "@/lib/clipboard";
import type { EditorReadFileResult } from "@/lib/tauri/codespace";
import { editorReadFileSsh, type SshToolTarget } from "@/lib/tauri/codespace-editor-ssh";
import { WorkbenchEditor, type WorkbenchEditorApi } from "@/modules/codespace/components/workbench/WorkbenchEditor";
import { WorkbenchMarkdownPreview } from "@/modules/codespace/components/workbench/WorkbenchMarkdownPreview";
import { WorkbenchMediaPreview } from "@/modules/codespace/components/workbench/WorkbenchMediaPreview";
import { editorMediaType, formatByteSize } from "@/modules/codespace/services/editor-media";

import { absPath, filterFiles, mentionedPaths, parseFileRef, type FileRef } from "../domain/files";
import {
  openChatFileExternally,
  readChatFile,
  readChatFileBytes,
  readChatFileTail,
  revealChatFile,
  statChatFile,
  writeChatFile,
} from "../runtime/chat-runtime-client";
import type { ChatFolderFiles } from "../view-model/useChatFiles";
import { LinesSkeleton, LoadError } from "./ChatChanges";
import { FilesTree, TreeRow } from "./ChatFilesTree";
import { SelectionToChat } from "./SelectionToChat";
import { MenuItem } from "./ThreadActions";
import { highlightLines, languageOf } from "./code-highlight";

// Mockup: mockups/lotus-chat.fig, page "05b Files" (#282). Files sits beside Changes in the same
// drawer; paths in replies and steps are links that open the file at the line.

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

interface FileLinks {
  cwd: string;
  /** The folder-relative file a path means, or null when it is not one (or not only one). */
  resolve: (path: string) => string | null;
  open: (ref: FileRef) => void;
  /** Opens a web address (`https:` or `file:`) in Preview; absent where there is no Preview. */
  browse?: (url: string) => void;
  /** Opens a folder-relative file's diff in Changes; offered only for files in `changed`. */
  review?: (path: string) => void;
  changed?: ReadonlySet<string>;
}

export const isPage = (path: string) => /\.html?$/i.test(path);

/** The small "open outside Lotus" button that follows a link. */
export function OutLink({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="chat-link-out"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      <ExternalLink size={11} strokeWidth={2.2} aria-hidden />
    </button>
  );
}

export const FileLinksContext = createContext<FileLinks | null>(null);

/** "Review" beside an edit in the timeline, while the file still has uncommitted changes. */
export function ReviewLink({ path }: { path: string }) {
  const links = useContext(FileLinksContext);
  const rel = links?.resolve(path);
  if (!links?.review || !rel || !links.changed?.has(rel)) return null;
  const { review } = links;
  return (
    <button type="button" className="chat-step-review" title={`Review ${rel} in Changes`} onClick={() => review(rel)}>
      Review
    </button>
  );
}

/** `text` as a link when it names a file in the chat's folder; plain `fallback` otherwise. */
export function FileLink({ text, fallback, children }: { text: string; fallback?: ReactNode; children: ReactNode }) {
  const links = useContext(FileLinksContext);
  const ref = parseFileRef(text);
  const path = ref && links?.resolve(ref.path);
  if (!links || !ref || !path) return <>{fallback ?? children}</>;
  const { browse } = links;
  if (browse && isPage(path)) {
    const abs = absPath(links.cwd, path);
    return (
      <span className="chat-link-pair">
        <button type="button" className="chat-file-link" title={`Open ${path} in Lotus`} onClick={() => browse(`file://${encodeURI(abs)}`)}>
          {children}
        </button>
        <OutLink label="Open in your browser" onOpen={() => void openChatFileExternally(links.cwd, path)} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chat-file-link"
      title={ref.line ? `Open at ${/\.pdf$/i.test(path) ? "page" : "line"} ${ref.line}` : `Open ${path}`}
      onClick={() => links.open({ path, line: ref.line })}
    >
      {children}
    </button>
  );
}

const CARD_KINDS: [RegExp, string][] = [
  [/\.(md|markdown|mdx|txt|rst)$/i, "doc"],
  [/\.pdf$/i, "pdf"],
  [/\.html?$/i, "page"],
  [/\.(csv|tsv|xlsx?|numbers)$/i, "sheet"],
  [/\.(png|jpe?g|gif|webp|svg|avif|heic|mp4|mov|webm)$/i, "media"],
  [/\.(tsx?|jsx?|mjs|rs|py|go|rb|java|kt|swift|dart|sh|json|ya?ml|toml|css|sql)$/i, "code"],
];

/** Cards shown before "Show N more". */
const CARD_LIMIT = 4;

/** mtimes a little older than the turn's start still count: the clocks are one machine's, the stamps are not. */
const SINCE_SLACK_MS = 2000;

/** Cards that mount this soon after their turn ended arrive with the edge glow; older ones (history, a remount) just sit there. */
const FRESH_MS = 10_000;

interface CardFile {
  size: number;
  /** Made by this turn, not only changed. */
  isNew: boolean;
}

/**
 * Under a turn's closing reply, the files it names that the turn made or changed (mtime since
 * `since`), as cards (mockup `mockups/chat-file-card-arrival.html`). A file only mentioned stays a
 * link in the text: a card for it would show the same name twice.
 */
export function ReplyFiles({ text, since, endedAt }: { text: string; since: number; endedAt?: number }) {
  const links = useContext(FileLinksContext);
  const [all, setAll] = useState(false);
  // Read once, at mount: a reply still being answered, or just answered, is live.
  const [arrive] = useState(() => endedAt === undefined || Date.now() - endedAt < FRESH_MS);
  // Per changed file; files not yet read, unreadable or unchanged are absent.
  const [changed, setChanged] = useState<ReadonlyMap<string, CardFile>>(new Map());
  const paths = links ? [...new Set(mentionedPaths(text).flatMap((p) => links.resolve(p) ?? []))] : [];
  const cwd = links?.cwd ?? "";
  const key = paths.join("\n");
  useEffect(() => {
    if (!key) return;
    let live = true;
    const from = since - SINCE_SLACK_MS;
    void Promise.all(
      key.split("\n").map((path) =>
        statChatFile(absPath(cwd, path)).then(
          (file) => (file.mtime >= from ? ([path, { size: file.sizeBytes, isNew: file.created !== null && file.created >= from }] as const) : null),
          () => null,
        ),
      ),
    ).then((found) => live && setChanged(new Map(found.filter((f) => f !== null))));
    return () => {
      live = false;
    };
  }, [key, cwd, since]);
  if (!links) return null;
  const cards = paths.filter((p) => changed.has(p));
  if (cards.length === 0) return null;
  const shown = all ? cards : cards.slice(0, CARD_LIMIT);
  return (
    <div className="chat-file-cards" aria-label="Files from this reply">
      {shown.map((path, i) => (
        <FileCard key={path} path={path} file={changed.get(path)!} links={links} order={arrive ? i : null} />
      ))}
      {cards.length > shown.length && (
        <button type="button" className="chat-file-cards-more" onClick={() => setAll(true)}>
          Show {cards.length - shown.length} more
        </button>
      )}
    </div>
  );
}

/** `order` is the card's place in a live arrival (it staggers the glow); null when it just sits there. */
function FileCard({ path, file, links, order }: { path: string; file: CardFile; links: FileLinks; order: number | null }) {
  const [arriving, setArriving] = useState(order !== null);
  const abs = absPath(links.cwd, path);
  const name = abs.slice(abs.lastIndexOf("/") + 1);
  const kind = CARD_KINDS.find(([re]) => re.test(name))?.[1] ?? "file";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
  const { browse } = links;
  return (
    // The slot owns the rise: a transform makes its own layer, and the card's glow must sit under the card.
    <div className="chat-file-card-slot" data-arrive={arriving || undefined} style={order !== null ? ({ "--i": order } as CSSProperties) : undefined}>
      <div
        className="chat-file-card"
        data-kind={kind}
        data-arrive={arriving || undefined}
        onAnimationEnd={(event) => event.animationName === "chat-file-card-glow" && setArriving(false)}
      >
        <button
          type="button"
          className="chat-file-card-open"
          title={`Open ${abs} in Lotus`}
          onClick={() => (browse && isPage(path) ? browse(`file://${encodeURI(abs)}`) : links.open({ path, line: null }))}
        >
          <span className="chat-file-card-ext" aria-hidden>
            {ext}
          </span>
          <span className="chat-file-card-name">{name}</span>
          {file.isNew && <span className="chat-file-card-new" role="img" aria-label="new" />}
          <span className="chat-file-card-size">{formatByteSize(file.size)}</span>
        </button>
        <button
          type="button"
          className="chat-file-card-out"
          aria-label={`Open ${name} in its default app`}
          title="Open in default app"
          onClick={() => void openChatFileExternally(links.cwd, path)}
        >
          <ArrowUpRight size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export interface FileTarget extends FileRef {
  /** Bumped per click, so opening the same line twice still scrolls to it. */
  n: number;
}

interface FilesPaneProps {
  shown: boolean;
  cwd: string;
  folder: ChatFolderFiles;
  /** Folder-relative paths this chat's folder has uncommitted changes in. */
  changed: ReadonlySet<string>;
  target: FileTarget | null;
  /** Bumped by ⌘P: back to the tree with the filter focused. */
  find: number;
  /** Changes when the agent may have written files. */
  version: string;
  agentName: string;
  /** Puts a reference to the open file (and its page or line) in the composer. */
  onMention?: (text: string) => void;
  /** A file was made, renamed or trashed here: read the folder again. */
  onFilesChanged?: () => void;
  /** The folder is on this SSH machine: browse and read only (mockups/chat-remote-machine.html, 9). */
  remote?: SshToolTarget | null;
}

export function FilesPane({ shown, cwd, folder, changed, target, find, version, agentName, onMention, onFilesChanged, remote = null }: FilesPaneProps) {
  // `edit`: a file just made in the tree opens ready to type in.
  const [current, setCurrent] = useState<(FileRef & { edit?: boolean }) | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => filterFiles(folder.files, query), [folder.files, query]);

  // A link click or ⌘P changes what is shown; adjusted while rendering, not in an effect.
  const [seen, setSeen] = useState({ n: 0, find });
  if (target && target.n !== seen.n) {
    setSeen({ ...seen, n: target.n });
    setCurrent({ path: target.path, line: target.line });
    // Its folders open too, so Back lands where the file is.
    const next = new Set(expanded);
    const parts = target.path.split("/");
    for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
    setExpanded(next);
  } else if (find !== seen.find) {
    setSeen({ ...seen, find });
    setCurrent(null);
  }

  useEffect(() => {
    // After the drawer's slide has started, or focus would scroll the hidden pane into view.
    if (find) requestAnimationFrame(() => input.current?.select());
  }, [find]);

  if (current && remote) return <RemoteFileView key={current.path} target={remote} cwd={cwd} path={current.path} onBack={() => setCurrent(null)} />;
  if (current) {
    return (
      <FileView
        key={current.path}
        shown={shown}
        cwd={cwd}
        file={current}
        changed={changed.has(current.path)}
        version={version}
        agentName={agentName}
        startEditing={current.edit}
        onBack={() => setCurrent(null)}
        onOpen={(path) => setCurrent({ path, line: null })}
        onMention={onMention}
      />
    );
  }

  const open = (path: string) => setCurrent({ path, line: null });
  return (
    <div className="chat-files">
      <label className="chat-files-find">
        <input
          ref={input}
          type="text"
          aria-label="Go to file"
          placeholder="Go to file…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) open(matches[0]);
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        <kbd>⌘P</kbd>
      </label>
      {folder.error && <p className="chat-changes-error">{folder.error}</p>}
      {query ? (
        <div className="chat-files-tree" aria-label="Files">
          {matches.map((path) => {
              const slash = path.lastIndexOf("/");
              return (
                <TreeRow
                  key={path}
                  entry={{ name: path.slice(slash + 1), path, folder: false }}
                  dir={slash > 0 ? path.slice(0, slash) : ""}
                  depth={0}
                  open={false}
                  changed={changed.has(path)}
                  onClick={() => open(path)}
                />
              );
          })}
          {matches.length === 0 && <p className="chat-changes-empty">No file matches “{query}”</p>}
        </div>
      ) : (
        <FilesTree
          cwd={cwd}
          files={folder.files}
          changed={changed}
          expanded={expanded}
          setExpanded={setExpanded}
          onOpen={(path, edit) => setCurrent({ path, line: null, edit })}
          onMention={onMention}
          onChanged={() => onFilesChanged?.()}
          readOnly={remote !== null}
          dragToChat={remote !== null}
        />
      )}
      {folder.truncated && <p className="chat-files-note">Large folder: some files are not listed.</p>}
      {remote && <p className="chat-files-note">Read over SSH from {remote.host}.</p>}
    </div>
  );
}

/** A remote chat's file, read over SSH and shown as text; editing stays on the machine for now. */
function RemoteFileView({ target, cwd, path, onBack }: { target: SshToolTarget; cwd: string; path: string; onBack: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    editorReadFileSsh({ target, remoteCwd: cwd }, path).then(
      (file) => live && setText(file.content),
      (reason: unknown) => live && setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      live = false;
    };
  }, [target, cwd, path]);
  return (
    <div className="chat-files chat-files-remote">
      <div className="chat-files-path">
        <button type="button" className="chat-files-back" aria-label="Back to files" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden />
        </button>
        <span className="chat-files-crumb" title={path}>
          <span className="chat-files-name">{path.slice(path.lastIndexOf("/") + 1)}</span>
          {path.includes("/") && <span className="chat-files-dir">{path.slice(0, path.lastIndexOf("/"))}</span>}
        </span>
      </div>
      {error ? <p className="chat-changes-error">{error}</p> : text === null ? <p className="chat-files-note">Reading from {target.host}…</p> : <pre className="chat-files-remote-text">{text}</pre>}
    </div>
  );
}

/** "Show the end" of a file too large to read whole: as much of a log as anyone scrolls back. */
const TAIL_LINES = 2000;
/** `allowLarge` reads up to this (MAX_EDITOR_LARGE_FILE_SIZE_BYTES); past it only the end is offered. */
const LARGE_LIMIT = 50 * 1024 * 1024;
const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** Where each file was scrolled to, by absolute path, for as long as the app runs. */
const readPlace = new Map<string, number>();

/** What is read: the file, the file past the 10 MB cap ("Open anyway"), or only its end. */
type Reach = "whole" | "large" | "tail";

interface FileViewProps {
  shown: boolean;
  cwd: string;
  file: FileRef;
  changed: boolean;
  version: string;
  agentName: string;
  /** Opens straight into the editor, once the file is read. */
  startEditing?: boolean;
  onBack: () => void;
  /** Opens another file of the folder (a link in a Markdown preview). */
  onOpen: (path: string) => void;
  onMention?: (text: string) => void;
}

function FileView({ shown, cwd, file, changed, version, agentName, startEditing = false, onBack, onOpen, onMention }: FileViewProps) {
  const root = cwd.replace(/\/+$/, "");
  const abs = absPath(root, file.path);
  // SVG is text: it stays in the text view, where it can be edited.
  const viewer = editorMediaType(file.path);
  const media = viewer && !viewer.textual ? viewer : null;
  const markdown = MARKDOWN.test(file.path);
  const [reach, setReach] = useState<Reach>("whole");
  // A link to a line wants the source; otherwise Markdown opens rendered.
  const [source, setSource] = useState(file.line !== null);
  // What is on disk (read again as the agent works), and what an edit started from.
  const [disk, setDisk] = useState<EditorReadFileResult | null>(null);
  const [base, setBase] = useState<EditorReadFileResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The mtime of the media on screen. Video and audio keep the version being played until the
  // reader reloads; an image follows the disk, and a PDF does too at the same scroll place.
  const [showing, setShowing] = useState<number | null>(null);
  const follows = media?.kind === "image" || media?.kind === "pdf";
  const pdf = media?.kind === "pdf";
  // The PDF page being read, for a mention.
  const [page, setPage] = useState<number | null>(null);
  const rootEl = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const editor = useRef<WorkbenchEditorApi | null>(null);
  const editing = draft !== null && base !== null;
  const clash = editing && disk !== null && disk.mtime !== base.mtime;

  if (media && disk && (showing === null || (follows && showing !== disk.mtime))) setShowing(disk.mtime);
  const stale = media !== null && disk !== null && showing !== null && showing !== disk.mtime;

  useEffect(() => {
    if (!shown) return;
    let live = true;
    // shortcut: for media this reads the file (≤10 MB) only for its mtime; add a stat command if a big PDF feels slow.
    const read = reach === "tail" ? readChatFileTail(abs, TAIL_LINES) : reach === "large" ? readChatFile(abs, true) : readChatFile(abs);
    read.then(
      (fresh) => {
        if (!live) return;
        setError(null);
        // Read again as the agent works: an unchanged file keeps its object, so nothing re-renders.
        setDisk((prev) => (prev && prev.mtime === fresh.mtime && prev.sizeBytes === fresh.sizeBytes && prev.content === fresh.content ? prev : fresh));
      },
      (reason: unknown) => live && setError(message(reason)),
    );
    return () => {
      live = false;
    };
  }, [abs, version, shown, reach, attempt]);

  // Scroll the asked-for line into view once the text is there; the end of a log to its end.
  useEffect(() => {
    if (!disk) return;
    if (reach === "tail" && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [disk, reach]);

  // Back where the reader left this file: after Back and reopening, or a switch of tabs. A link to
  // a line scrolls to the line instead.
  const loaded = disk !== null;
  useEffect(() => {
    const el = body.current;
    if (!el || !shown || !loaded || file.line !== null || reach === "tail") return;
    el.scrollTop = readPlace.get(abs) ?? 0;
  }, [abs, shown, loaded, file.line, reach]);


  // Focus follows the opened file (from a link, the tree or ⌘P), so E works without a click.
  useEffect(() => {
    if (shown && !editing) rootEl.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a file is opened or shown, not after an edit
  }, [file, shown]);

  const readable = disk !== null && !disk.binary;
  const editable = readable && reach !== "tail";
  const [wantsEdit, setWantsEdit] = useState(startEditing);
  if (wantsEdit && editable && !editing) {
    setWantsEdit(false);
    setBase(disk);
    setDraft(disk.content);
  }
  const edit = () => {
    if (!editable) return;
    setBase(disk);
    setDraft(disk.content);
  };
  const discard = () => {
    setDraft(null);
    setBase(null);
  };
  /** `over` saves over what is on disk now, after a clash. */
  const save = async (over = false) => {
    if (!editing || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { mtime } = await writeChatFile(abs, draft, over && disk ? disk.mtime : base.mtime, base.encoding);
      setDisk({ ...base, content: draft, mtime });
      discard();
    } catch (reason) {
      const text = message(reason);
      // The banner then offers both versions.
      if (text.includes("changed on disk")) await readChatFile(abs).then(setDisk, () => setError(text));
      else setError(text);
    } finally {
      setSaving(false);
    }
  };
  const readAs = (next: Reach) => {
    setDisk(null);
    setReach(next);
  };
  // A file outside the folder (absolute) is taken relative to its own folder: reveal stays within a root.
  const [actionRoot, actionPath] = file.path.startsWith("/") ? [abs.slice(0, abs.lastIndexOf("/")), abs.slice(abs.lastIndexOf("/") + 1)] : [root, file.path];
  const external = (action: (cwd: string, path: string) => Promise<void>) => () =>
    void action(actionRoot, actionPath).catch((reason: unknown) => setError(message(reason)));

  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "FILE";
  const lineCount = readable ? disk.content.split("\n").length : 0;
  const rendered = readable && markdown && !source && !editing;

  return (
    <div
      ref={rootEl}
      tabIndex={-1}
      className="chat-files chat-files-view"
      onKeyDown={(event) => {
        const inField = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
        if (editing && event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        } else if (editing && event.key === "Escape" && !event.nativeEvent.defaultPrevented) {
          // Monaco keeps an Esc it used (closing suggestions or find); only a free one discards.
          event.stopPropagation();
          discard();
        } else if (!editing && !inField && event.key === "e" && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          edit();
        }
      }}
    >
      <div className="chat-files-path">
        <button type="button" className="chat-files-back" aria-label="Back to files" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden />
        </button>
        {/* Name first, its folder after it in quiet text (mockups/chat-workbench-refine.html). */}
        <span className="chat-files-crumb" title={file.path}>
          <span className="chat-files-name">{name}</span>
          {file.line && <span className="chat-files-dir">· {pdf ? "page" : "line"} {file.line}</span>}
          {slash > 0 && <span className="chat-files-dir">{file.path.slice(0, slash)}</span>}
          {changed && <span className="chat-files-dot" aria-label="changed" />}
        </span>
        {disk && (media || disk.binary || reach === "tail") && (
          <span className="chat-files-meta">
            {media?.label ?? ext} · {formatByteSize(disk.sizeBytes)}
          </span>
        )}
        {readable && markdown && !editing && (
          <span className="chat-drawer-seg chat-files-mode" role="group" aria-label="Markdown view">
            <button type="button" className="chat-drawer-tab" aria-pressed={!source} onClick={() => setSource(false)}>
              Preview
            </button>
            <button type="button" className="chat-drawer-tab" aria-pressed={source} onClick={() => setSource(true)}>
              Source
            </button>
          </span>
        )}
        {editable && !editing && (
          <button type="button" className="chat-files-back" aria-label="Edit" aria-keyshortcuts="E" title="Edit · E" onClick={edit}>
            <Pencil size={13} aria-hidden />
          </button>
        )}
        {/* The rarer actions, behind ⋯. */}
        <MoreMenu
          name={name}
          items={[
            ...(onMention
              ? [{ label: "Mention in chat", keycap: "@", run: () => onMention(`\`${file.path}${!pdf && file.line ? `:${file.line}` : ""}\`${pdf && page ? ` (page ${page})` : ""} `) }]
              : []),
            { label: "Copy path", keycap: "", run: () => void copyTextToClipboard(abs).catch((reason: unknown) => setError(message(reason))) },
            { label: "Open with default app", keycap: "", run: external(openChatFileExternally) },
            { label: "Reveal in Finder", keycap: "", run: external(revealChatFile) },
          ]}
        />
      </div>

      {clash && (
        <div className="chat-files-clash" role="alert">
          <span>{agentName} or another app changed this file while you were editing</span>
          <span className="chat-files-clash-actions">
            <button
              type="button"
              className="chat-btn"
              onClick={discard}
            >
              Load theirs
            </button>
            <button type="button" className="chat-btn" onClick={() => void save(true)}>
              Keep mine
            </button>
          </span>
        </div>
      )}
      {stale && (
        <div className="chat-files-clash" role="status">
          <span>{agentName} updated this file · you are still on the version you were reading</span>
          <span className="chat-files-clash-actions">
            <button type="button" className="chat-btn" onClick={() => setShowing(disk.mtime)}>
              Reload
            </button>
          </span>
        </div>
      )}
      {error && disk && <p className="chat-changes-error">{error}</p>}

      <div
        ref={body}
        className="chat-files-body"
        data-media={media ? "" : undefined}
        // Not while hidden: a hidden scroller reads 0.
        onScroll={(event) => shown && readPlace.set(abs, event.currentTarget.scrollTop)}
      >
        {!disk && !error && <LinesSkeleton label="Reading the file" />}
        {!disk && error && (
          <LoadError
            text={error}
            onRetry={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          />
        )}
        {media && showing !== null && (
          // The panel tokens the Code mode viewer is drawn with.
          <div className="chat-files-media codespace-panel-surface">
            <WorkbenchMediaPreview
              fileName={name}
              media={media}
              source={{ kind: "bytes", load: () => readChatFileBytes(abs), version: showing }}
              page={pdf ? file.line : null}
              onPage={setPage}
            />
          </div>
        )}
        {disk?.binary && !media && (
          <div className="chat-files-card">
            <span className="chat-files-glyph" aria-hidden>
              {ext.slice(0, 4)}
            </span>
            <strong>{disk.tooLarge ? `${name} is ${formatByteSize(disk.sizeBytes)}` : name}</strong>
            <p>{disk.tooLarge ? "Too large to read here at once." : `${formatByteSize(disk.sizeBytes)} · Lotus can't preview this type.`}</p>
            <div className="chat-files-card-actions">
              {disk.tooLarge && (
                <button type="button" className="chat-changes-commit" onClick={() => readAs("tail")}>
                  Show last {TAIL_LINES.toLocaleString("en-US")} lines
                </button>
              )}
              {disk.tooLarge && reach === "whole" && disk.sizeBytes <= LARGE_LIMIT && (
                <button type="button" className="chat-btn" onClick={() => readAs("large")}>
                  Open anyway
                </button>
              )}
              <button type="button" className="chat-btn" onClick={external(openChatFileExternally)}>
                Open with default app
              </button>
              <button type="button" className="chat-btn" onClick={external(revealChatFile)}>
                Reveal in Finder
              </button>
            </div>
          </div>
        )}
        {rendered && (
          <div className="chat-files-markdown codespace-panel-surface">
            <WorkbenchMarkdownPreview
              content={disk.content}
              filePath={abs}
              rootDir={root}
              loadFile={readChatFileBytes}
              onOpenFile={(path) => onOpen(path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)}
            />
          </div>
        )}
        {readable &&
          !rendered &&
          (draft !== null ? (
            <WorkbenchEditor
              // Its own model key: Monaco keeps one model per path, shared with a Code tab of the same file.
              filePath={`lotus-chat:${abs}`}
              content={draft}
              loading={false}
              binary={false}
              error={null}
              // The footer has Save; `dirty` would add the editor's own floating button.
              dirty={false}
              onChange={setDraft}
              onSave={() => void save()}
              wordWrap={markdown || /\.txt$/i.test(file.path)}
              onEditorReady={(api) => {
                editor.current = api;
                api.focus();
              }}
            />
          ) : (
            <>
              <CodeLines path={file.path} text={disk.content} hit={reach === "tail" ? null : file.line} scroller={body} />
              {onMention && <SelectionToChat scope={body} path={file.path} onAdd={onMention} />}
            </>
          ))}
      </div>

      {/* Only while editing, or reading a log's end: a plain read has no footer (the hint is on Edit). */}
      {(editing || (reach === "tail" && readable)) && <footer className="chat-files-foot">
        {editing ? (
          <>
            <span>Edited · not saved</span>
            <button
              type="button"
              className="chat-btn chat-btn--ghost"
              onClick={discard}
            >
              Discard · Esc
            </button>
            <button type="button" className="chat-changes-commit" disabled={saving || draft === base?.content} onClick={() => void save()}>
              Save
              <kbd>⌘S</kbd>
            </button>
          </>
        ) : reach === "tail" && readable ? (
          <>
            <span>Last {lineCount.toLocaleString("en-US")} lines · read-only</span>
            <button type="button" className="chat-btn chat-btn--ghost" onClick={() => readAs("whole")}>
              Back
            </button>
          </>
        ) : null}
      </footer>}
    </div>
  );
}

interface MoreItem {
  label: string;
  keycap: string;
  run: () => void;
}

/** ⋯ in the file's header: the tree's menu (`.chat-thread-menu`), opened under the button. */
function MoreMenu({ name, items }: { name: string; items: MoreItem[] }) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ right: number; top: number } | null>(null);
  const close = () => {
    setAt(null);
    button.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const el = menu.current;
    if (!at || !el) return;
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const outside = (event: PointerEvent) => !el.contains(event.target as Node) && !button.current?.contains(event.target as Node) && setAt(null);
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [at]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="chat-files-back"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        title="More"
        onClick={() => {
          if (at) return setAt(null);
          const r = button.current!.getBoundingClientRect();
          setAt({ right: innerWidth - r.right, top: r.bottom + 6 });
        }}
      >
        <Ellipsis size={14} aria-hidden />
      </button>
      {at &&
        createPortal(
          <div
            ref={menu}
            className="chat-thread-menu"
            role="menu"
            aria-label={`Actions for ${name}`}
            style={{ right: at.right, top: at.top }}
            onKeyDown={(event) => {
              const all = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
              const i = all.indexOf(document.activeElement as HTMLElement);
              if (event.key === "Escape" || event.key === "Tab") close();
              else if (event.key === "ArrowDown") all[(i + 1) % all.length]?.focus();
              else if (event.key === "ArrowUp") all[(i - 1 + all.length) % all.length]?.focus();
              else return;
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {items.map((item) => (
              <MenuItem
                key={item.label}
                label={item.label}
                keycap={item.keycap}
                onClick={() => {
                  close();
                  item.run();
                }}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A text file as numbered lines, only those near the viewport mounted: "Open anyway" can bring in a
 * file of millions of lines. The scroller is `.chat-files-body`, whose first child this is.
 */
function CodeLines({ path, text, hit, scroller }: { path: string; text: string; hit: number | null; scroller: RefObject<HTMLDivElement | null> }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const html = useMemo(() => highlightLines(text, languageOf(path)), [text, path]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 20,
    overscan: 40,
    paddingStart: 8,
    paddingEnd: 8,
  });
  // The asked-for line, centred once the text is there.
  useEffect(() => {
    if (hit && hit <= lines.length) virtualizer.scrollToIndex(hit - 1, { align: "center" });
  }, [hit, lines, virtualizer]);
  return (
    <div className="chat-files-code chat-code-hl" role="table" aria-label={path} aria-rowcount={lines.length} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          ref={virtualizer.measureElement}
          data-index={item.index}
          className="chat-files-line"
          role="row"
          aria-rowindex={item.index + 1}
          data-line={item.index + 1}
          data-hit={item.index + 1 === hit || undefined}
          style={{ transform: `translateY(${item.start}px)` }}
        >
          <span className="chat-changes-no">{item.index + 1}</span>
          {html?.[item.index] != null ? (
            // highlight.js escapes the source; only its own <span class> markup is in here.
            <span className="chat-changes-code" dangerouslySetInnerHTML={{ __html: html[item.index] }} />
          ) : (
            <span className="chat-changes-code">{lines[item.index]}</span>
          )}
        </div>
      ))}
    </div>
  );
}
