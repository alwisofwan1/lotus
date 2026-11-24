"use client";

import { Check, ChevronRight, ChevronsDownUp, Columns2, Eye, GitBranch, GitMerge, Lock, Maximize2, MessageSquare, Minimize2, Plus, Rows2, Search, Space, Undo2, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  agentFiles,
  defaultPicks,
  fileRevision,
  filterChangedFiles,
  parseDiff,
  splitRows,
  totals,
  undoCandidates,
  undoDefault,
  type ChangedFile,
  type Changes,
  type Delegated,
  type DiffRow,
} from "../domain/changes";
import { reviewNote, reviewNoteRef, type Quote, type ReviewNote } from "../domain/quotes";
import { WORKBENCH_TABS, type WorkbenchTab } from "../domain/workbench";
import { commitChatChanges, discardChildChat, getChatChangeDiff, mergeChildChat, undoChatChanges } from "../runtime/chat-runtime-client";
import { highlightRows, languageOf } from "./code-highlight";
import { SelectionToChat } from "./SelectionToChat";
// Mockup: mockups/lotus-chat.fig, page "05a Changes", board B (#281). A bar docked above the
// composer opens a drawer where every changed file stacks in one column: the agent's ticked, the
// user's own unticked. Undo puts the agent's files back as they were before its first edit.

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return <span className="chat-changes-binary">binary</span>;
  return (
    <>
      <span className="chat-changes-add">+{added ?? 0}</span>
      <span className="chat-changes-del">−{removed ?? 0}</span>
    </>
  );
}

interface ChangesBarProps {
  changes: Changes | null;
  agentName: string;
  /** The agent changed a file in this chat at some point, so a clean folder is worth saying. */
  touched: boolean;
  receipt: string | null;
  /** Beside the receipt; "" for none. */
  receiptHint?: string;
  open: boolean;
  onToggle: () => void;
  /** The newest check's result (#283), at the bar's end. */
  run?: ReactNode;
}

export function ChangesBar({ changes, agentName, touched, receipt, receiptHint = "Push in Code", open, onToggle, run }: ChangesBarProps) {
  if (receipt) {
    return (
      <div key="done" className="chat-changes-bar" data-tone="done" role="status">
        <span className="chat-changes-bar-text">{receipt}</span>
        {receiptHint && <span className="chat-changes-bar-hint">{receiptHint}</span>}
      </div>
    );
  }
  const mine = agentFiles(changes);
  if (mine.length === 0) {
    const calm = touched && !!changes?.branch;
    if (!calm && !run) return null;
    return (
      <div key="calm" className="chat-changes-bar" data-tone="calm">
        {calm && (
          <>
            <Check size={12} strokeWidth={2.4} className="chat-changes-ok" aria-hidden />
            <span className="chat-changes-bar-text">Nothing changed in this folder</span>
          </>
        )}
        {run && <span className="chat-changes-bar-run">{run}</span>}
      </div>
    );
  }
  const sum = totals(mine);
  return (
    <div key="live" className="chat-changes-bar">
      <span className="chat-changes-bar-text">
        {agentName} changed {sum.files} {sum.files === 1 ? "file" : "files"}
      </span>
      <Counts added={sum.added} removed={sum.removed} />
      {run && <span className="chat-changes-bar-run">{run}</span>}
      <button type="button" className="chat-changes-review" aria-expanded={open} onClick={onToggle}>
        {open ? "Hide" : "Review"}
        <kbd>⌘R</kbd>
      </button>
    </div>
  );
}

export type DrawerPane = WorkbenchTab;

const PANES = WORKBENCH_TABS;
const PANE_LABEL: Record<DrawerPane, string> = { changes: "Changes", files: "Files", runs: "Runs", preview: "Preview", context: "Context" };

interface ChatDrawerProps {
  /** Closed, it stays mounted off-screen, so ticks, the message and an open file survive a hide. */
  open: boolean;
  pane: DrawerPane;
  onPane: (pane: DrawerPane) => void;
  /** Files changed and checks run, for the switch's counts. */
  counts: Partial<Record<DrawerPane, number>>;
  onClose: () => void;
  /** Wide: the drawer takes the page and the chat narrows to a column (a PDF, a diff). */
  wide?: boolean;
  onWide?: () => void;
  /** A width dragged to on the left edge, with the room the page has for chat and panel together. */
  onResize?: (px: number, room: number) => void;
  /** Double-click on the edge: back to the default width. */
  onResetWidth?: () => void;
  changes: ReactNode;
  files: ReactNode;
  runs: ReactNode;
  preview?: ReactNode;
  context?: ReactNode;
  /** The tabs to offer; all of them when absent. A remote chat has Changes and Files only. */
  tabs?: readonly DrawerPane[];
}

/** The Workbench drawer: Changes (#281), Files (#282) and Runs (#283) behind one switch. */
export function ChatDrawer({ open, pane, onPane, counts, onClose, wide = false, onWide, onResize, onResetWidth, tabs = PANES, ...content }: ChatDrawerProps) {
  const panes = useRef<Record<DrawerPane, HTMLDivElement | null>>({ changes: null, files: null, runs: null, preview: null, context: null });

  // Focus moves into the pane on open and on a switch, so its keys work at once. Not when the
  // pane already took it: an opened file focuses itself first (child effects run before this).
  useEffect(() => {
    const el = panes.current[pane];
    if (open && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [open, pane]);

  return (
    <div className="chat-changes-slot" data-open={open || undefined} inert={!open}>
      {onResize && <ResizeEdge onResize={onResize} onReset={onResetWidth} />}
      <aside
        className="chat-changes"
        aria-label="Workbench"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="chat-changes-head">
          <div className="chat-drawer-seg" role="tablist" aria-label="Workbench">
            {tabs.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={pane === id}
                className="chat-drawer-tab"
                title={id === "preview" ? "Preview · ⇧⌘B" : id === "files" ? "Files · ⌘P" : undefined}
                onClick={() => onPane(id)}
              >
                {PANE_LABEL[id]}
                {!!counts[id] && <span className="chat-drawer-count">{counts[id]}</span>}
              </button>
            ))}
          </div>
          {/* The Preview's address bar draws itself here: one row with the tabs when there is room (mockups/chat-preview-layout.html, A). */}
          <div className="chat-drawer-slot" />
          {pane === "files" && (
            <span className="chat-changes-keys" title="⌘P: go to file" aria-hidden>
              <kbd>⌘P</kbd>
            </span>
          )}
          {onWide && (
            <button
              type="button"
              className="chat-changes-close chat-drawer-wide"
              aria-label={wide ? "Narrow workbench" : "Widen workbench"}
              aria-pressed={wide}
              aria-keyshortcuts="Shift+Meta+Enter"
              title={wide ? "Narrow · ⇧⌘↩" : "Widen · ⇧⌘↩"}
              onClick={onWide}
            >
              {wide ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
            </button>
          )}
          <button type="button" className="chat-changes-close" aria-label="Close workbench" aria-keyshortcuts="Meta+R" title="Close · ⌘R" onClick={onClose}>
            <X size={14} aria-hidden />
          </button>
        </header>
        {PANES.map((id) => (
          <div
            key={id}
            ref={(el) => {
              panes.current[id] = el;
            }}
            tabIndex={-1}
            role="tabpanel"
            className="chat-drawer-pane"
            hidden={pane !== id}
          >
            {content[id]}
          </div>
        ))}
      </aside>
    </div>
  );
}

/** Space for the chat column and the panel together: the page less its rail. */
function room(edge: HTMLElement): number {
  const page = edge.closest<HTMLElement>(".chat-page");
  if (!page) return window.innerWidth;
  const rail = page.querySelector<HTMLElement>(":scope > .chat-rail");
  return page.getBoundingClientRect().width - (rail?.getBoundingClientRect().width ?? 0);
}

/**
 * The panel's left edge: drag to resize, double-click to reset, arrows from the keyboard. While
 * dragging, the width goes straight to the page's CSS variable (no render per move) and a shield
 * covers the window, so the native Preview browser steps aside instead of swallowing the pointer.
 */
function ResizeEdge({ onResize, onReset }: { onResize: (px: number, room: number) => void; onReset?: () => void }) {
  const [dragging, setDragging] = useState(false);
  const edge = useRef<HTMLDivElement>(null);
  const width = () => edge.current?.parentElement?.getBoundingClientRect().width ?? 0;
  return (
    <>
      <div
        ref={edge}
        className="chat-drawer-edge"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workbench"
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onDoubleClick={onReset}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onResize(width() + (event.key === "ArrowLeft" ? 24 : -24), room(event.currentTarget));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const el = event.currentTarget;
          const page = el.closest<HTMLElement>(".chat-page");
          const space = room(el);
          const right = el.parentElement!.getBoundingClientRect().right;
          let px = width();
          setDragging(true);
          page?.setAttribute("data-resizing", "");
          // Every way a drag can end finishes it once: a lost pointerup must never leave the
          // shield up (and the Preview browser hidden) with the column still following the pointer.
          const ends = ["pointerup", "pointercancel", "blur"] as const;
          const move = (e: PointerEvent) => {
            // The button came up where this window could not see it.
            if (e.buttons === 0) return end();
            px = Math.round(Math.max(320, Math.min(right - e.clientX, space - 420)));
            page?.style.setProperty("--chat-review-w", `${px}px`);
          };
          const end = () => {
            window.removeEventListener("pointermove", move);
            for (const type of ends) window.removeEventListener(type, end);
            el.removeEventListener("lostpointercapture", end);
            page?.removeAttribute("data-resizing");
            setDragging(false);
            onResize(px, space);
          };
          try {
            el.setPointerCapture(event.pointerId);
          } catch {
            // Not capturable (the pointer already went): the window listeners still end the drag.
          }
          window.addEventListener("pointermove", move);
          for (const type of ends) window.addEventListener(type, end);
          el.addEventListener("lostpointercapture", end);
        }}
      />
      {dragging && <div className="chat-drag-shield" data-covers-browser="" aria-hidden />}
    </>
  );
}

interface ChangesPaneProps {
  shown: boolean;
  threadId: string;
  /** null when the folder is not in a git repository. */
  changes: Changes | null;
  agentName: string;
  /** Git changed under the drawer: read it again. */
  onChanged: () => void;
  onCommitted: (sha: string, count: number) => void;
  /** Selected diff lines go to the composer. */
  onMention?: (text: string) => void;
  /** Open this file and bring it into view; a new `n` asks again for the same path. */
  target?: { path: string; n: number } | null;
  /** The agent is working: the Branch card offers no Discard. */
  working?: boolean;
  /** The Branch card's Discard deleted this chat; `text` says what went. */
  onDiscarded?: (text: string) => void;
  /** The chat runs on this SSH machine: files and line counts only, no diff (decision 8). */
  remoteHost?: string | null;
  /** Opens a file in Files; the remote list's rows use it. */
  onOpenFile?: (path: string) => void;
  /** The thread's waiting quotes; the Review notes among them show on their lines. */
  reviewNotes?: readonly Quote[];
  /** Absent: the diff takes no Review notes. */
  onReviewNote?: (change: ReviewNoteChange) => void;
  /** Open this Review note's editor (its file is opened through `target`); a new `n` asks again. */
  editNote?: { id: string; n: number } | null;
}

export type ReviewNoteChange = { kind: "add"; note: ReviewNote } | { kind: "edit"; id: string; note: string } | { kind: "remove"; id: string };

/**
 * Viewed marks per thread: path → the revision it was marked at.
 * shortcut: in memory only, so a restart forgets them; persist beside the Workbench state if asked.
 */
const viewedMarks = new Map<string, Map<string, string>>();

interface DiffView {
  split: boolean;
  ignoreWhitespace: boolean;
  onMention?: (text: string) => void;
  reviewNotes?: readonly Quote[];
  onReviewNote?: (change: ReviewNoteChange) => void;
  editNote?: { id: string; n: number } | null;
}

export function ChangesPane({ changes, ...rest }: ChangesPaneProps) {
  if (rest.remoteHost) return <RemoteChanges host={rest.remoteHost} files={changes?.files ?? []} onOpen={rest.onOpenFile} />;
  if (!changes?.branch) return <p className="chat-changes-empty">This folder is not in a git repository</p>;
  return <ChangesList changes={changes} {...rest} />;
}

/** mockups/chat-remote-machine.html, decision 8: the host sends counts, not patches, so far. */
function RemoteChanges({ host, files, onOpen }: { host: string; files: Changes["files"]; onOpen?: (path: string) => void }) {
  if (files.length === 0) return <p className="chat-changes-empty">No changes yet</p>;
  return (
    <div className="chat-remote-changes">
      {files.map((file) => (
        <button key={file.path} type="button" className="chat-remote-changes-row" title={`Open ${file.path}`} onClick={() => onOpen?.(file.path)}>
          <span className="chat-remote-changes-path">{file.path}</span>
          <Counts added={file.added} removed={file.removed} />
        </button>
      ))}
      <p className="chat-files-note">Line counts only. The diff stays on {host}.</p>
    </div>
  );
}

function ChangesList({ shown, threadId, changes, agentName, onChanged, onCommitted, onMention, target, working = false, onDiscarded, reviewNotes, onReviewNote, editNote }: ChangesPaneProps & { changes: Changes }) {
  const files = changes.files;
  const [picks, setPicks] = useState(() => defaultPicks(files));
  const [open, setOpen] = useState<string | null>(() => files.find((f) => f.agent)?.path ?? files[0]?.path ?? null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [query, setQuery] = useState("");
  const [split, setSplit] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  // A long tail of the user's own files starts folded, so the agent's work leads.
  const [folded, setFolded] = useState(() => files.some((f) => f.agent) && files.filter((f) => !f.agent).length > FOLD_OVER);
  const [viewed, setViewed] = useState(() => new Map(viewedMarks.get(threadId)));
  const known = useRef(new Set(files.map((f) => f.path)));
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // Grow the message with its text by hand: WKWebView ignores `field-sizing: content`. A scrollbar
  // only once it passes max-height, so a one-line message never draws one.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
  }, [text]);

  const markViewed = (file: ChangedFile, on: boolean) => {
    const next = new Map(viewed);
    if (on) next.set(file.path, fileRevision(file));
    else next.delete(file.path);
    viewedMarks.set(threadId, next);
    setViewed(next);
    if (on && open === file.path) setOpen(null); // done with it: fold it away
  };

  // Asked from outside (a timeline row): open the file and show it.
  useEffect(() => {
    if (!target || !files.some((f) => f.path === target.path)) return;
    setQuery("");
    setOpen(target.path);
    if (!files.find((f) => f.path === target.path)?.agent) setFolded(false);
    requestAnimationFrame(() =>
      list.current?.querySelector(`[data-path="${CSS.escape(target.path)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request moves the list
  }, [target?.n]);

  // A file that shows up later is ticked by the same rule; one that left drops out of the picks.
  useEffect(() => {
    setPicks((current) => {
      const next = new Set<string>();
      for (const f of files) if (current.has(f.path) || (f.agent && !known.current.has(f.path))) next.add(f.path);
      return next;
    });
    known.current = new Set(files.map((f) => f.path));
  }, [files]);

  const picked = files.filter((f) => picks.has(f.path));
  const sum = totals(picked);
  const all = totals(files);
  const visible = filterChangedFiles(files, query);
  const mine = visible.filter((f) => f.agent);
  const others = visible.filter((f) => !f.agent);
  const othersShown = folded && !query.trim() ? [] : others;
  const viewedCount = files.filter((f) => viewed.get(f.path) === fileRevision(f)).length;
  const view: DiffView = { split, ignoreWhitespace, onMention, reviewNotes, onReviewNote, editNote };
  const mixed = files.filter((f) => f.agent && (f.yoursBefore || f.yoursAfter)).length;

  const commit = async () => {
    if (busy || picked.length === 0 || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const sha = await commitChatChanges(threadId, picked.map((f) => f.path), text);
      setText("");
      onCommitted(sha, picked.length);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const step = (by: number) => {
    const order = [...mine, ...othersShown];
    if (order.length === 0) return;
    const at = order.findIndex((f) => f.path === open);
    const next = order[Math.min(order.length - 1, Math.max(0, at + by))];
    setOpen(next.path);
    list.current?.querySelector(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div
      ref={list}
      className="chat-changes-pane"
      onKeyDown={(event) => {
        const typing = (event.target instanceof HTMLInputElement && event.target.type === "text") || event.target instanceof HTMLTextAreaElement;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape" && undoing) {
          event.stopPropagation(); // the dialog closes, the drawer stays
        } else if (!typing && !event.metaKey && !event.ctrlKey && (event.key === "j" || event.key === "k")) {
          event.preventDefault();
          step(event.key === "j" ? 1 : -1);
        } else if (!typing && !event.metaKey && !event.ctrlKey && event.key === "v") {
          const file = files.find((f) => f.path === open);
          if (!file) return;
          event.preventDefault();
          markViewed(file, viewed.get(file.path) !== fileRevision(file));
        }
      }}
    >
      {changes.delegated && <BranchBlock key={threadId} threadId={threadId} branch={changes.delegated} onChanged={onChanged} onMention={onMention} working={working} onDiscarded={onDiscarded} />}

      <p className="chat-changes-sub chat-changes-summary">
        <span className="chat-changes-branch">
          <GitBranch size={12} aria-hidden />
          {changes.branch}
        </span>
        <Counts added={all.added} removed={all.removed} />
        <span className="chat-changes-quiet">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        {mixed > 0 && <span className="chat-changes-quiet">· {mixed} include your edits</span>}
        {viewedCount > 0 && (
          <span className="chat-changes-progress" title="Files you marked viewed">
            <span className="chat-changes-ring" style={{ "--p": (viewedCount / files.length) * 100 } as CSSProperties} aria-hidden />
            {viewedCount}/{files.length} viewed
          </span>
        )}
      </p>

      {files.length > 0 && (
        <div className="chat-changes-tools">
          <Search size={13} className="chat-changes-tools-icon" aria-hidden />
          <input
            type="text"
            className="chat-changes-filter"
            aria-label="Filter files"
            placeholder="Filter files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation(); // clears the filter, the drawer stays
                setQuery("");
              }
            }}
          />
          <span className="chat-changes-tools-sep" aria-hidden />
          <div className="chat-changes-seg" role="group" aria-label="Diff layout">
            <button type="button" aria-pressed={!split} aria-label="Unified" title="Unified diff" onClick={() => setSplit(false)}>
              <Rows2 size={13} aria-hidden />
            </button>
            <button type="button" aria-pressed={split} aria-label="Split" title="Split diff" onClick={() => setSplit(true)}>
              <Columns2 size={13} aria-hidden />
            </button>
            <button
              type="button"
              aria-pressed={ignoreWhitespace}
              aria-label="Hide whitespace changes"
              title="Hide whitespace changes"
              onClick={() => setIgnoreWhitespace((on) => !on)}
            >
              <Space size={13} aria-hidden />
            </button>
          </div>
          <button type="button" className="chat-changes-ws" aria-label="Collapse open file" title="Collapse open file" disabled={!open} onClick={() => setOpen(null)}>
            <ChevronsDownUp size={13} aria-hidden />
          </button>
        </div>
      )}

      <div className="chat-changes-list">
        {files.length === 0 && <p className="chat-changes-empty">Nothing changed in this folder</p>}
        {files.length > 0 && visible.length === 0 && <p className="chat-changes-empty">No files match “{query.trim()}”</p>}
        {mine.length > 0 && (
          <Group title={`Edited by ${agentName}`} hint="in this chat" files={mine} picks={picks} onPickAll={(on) => setPicks((s) => toggledAll(s, mine, on))} agent />
        )}
        {mine.map((f) => (
          <FileSection
            key={f.path}
            threadId={threadId}
            shown={shown}
            file={f}
            picked={picks.has(f.path)}
            open={open === f.path}
            viewed={viewed.has(f.path) ? viewed.get(f.path) === fileRevision(f) || "moved" : false}
            view={view}
            onPick={(on) => setPicks((s) => toggled(s, f.path, on))}
            onOpen={() => setOpen(open === f.path ? null : f.path)}
            onViewed={(on) => markViewed(f, on)}
          />
        ))}
        {others.length > 0 && (
          <Group
            title="Your changes"
            hint="Undo won’t touch these"
            files={others}
            picks={picks}
            onPickAll={(on) => setPicks((s) => toggledAll(s, others, on))}
            folded={othersShown.length === 0}
            onFold={query.trim() ? undefined : () => setFolded((f) => !f)}
          />
        )}
        {othersShown.map((f) => (
          <FileSection
            key={f.path}
            threadId={threadId}
            shown={shown}
            file={f}
            picked={picks.has(f.path)}
            open={open === f.path}
            viewed={viewed.has(f.path) ? viewed.get(f.path) === fileRevision(f) || "moved" : false}
            view={view}
            onPick={(on) => setPicks((s) => toggled(s, f.path, on))}
            onOpen={() => setOpen(open === f.path ? null : f.path)}
            onViewed={(on) => markViewed(f, on)}
          />
        ))}
      </div>

      <footer className="chat-changes-foot">
        {error && (
          <p className="chat-changes-error" role="alert">
            {error}
          </p>
        )}
        <div className="chat-changes-composer">
          <textarea
            ref={field}
            className="chat-changes-message"
            aria-label="Commit message"
            placeholder="Commit message"
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="chat-changes-composer-row">
            <span className="chat-changes-quiet">
              {picked.length === 0 ? (
                "No files selected"
              ) : (
                <>
                  {picked.length} selected · <Counts added={sum.added} removed={sum.removed} />
                </>
              )}
            </span>
            <button
              type="button"
              className="chat-changes-commit"
              disabled={busy || picked.length === 0 || !text.trim()}
              onClick={() => void commit()}
            >
              {picked.length === 0 ? "Select files to commit" : `Commit ${picked.length} ${picked.length === 1 ? "file" : "files"}`}
              <kbd>⌘↵</kbd>
            </button>
          </div>
        </div>
        <div className="chat-changes-actions">
          <button type="button" className="chat-changes-undo-edits" disabled={mine.length === 0 || busy} onClick={() => setUndoing(true)}>
            <Undo2 size={13} aria-hidden />
            Undo {agentName}’s edits
          </button>
          <span className="chat-changes-keys" aria-hidden>
            <span>
              <kbd>J</kbd>
              <kbd>K</kbd> move
            </span>
            <span>
              <kbd>V</kbd> viewed
            </span>
          </span>
        </div>
      </footer>

      {undoing && (
        <UndoDialog
          files={undoCandidates(files)}
          agentName={agentName}
          onCancel={() => setUndoing(false)}
          onUndo={async (paths) => {
            await undoChatChanges(threadId, paths);
            setUndoing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** The files a refused merge names: "<branch> conflicts with <into> in: a, b. Nothing was merged…". */
export function conflictFiles(error: string): string[] {
  const listed = / conflicts with .+? in: (.+?)\. Nothing was merged/.exec(error)?.[1];
  return listed ? listed.split(", ") : [];
}

const SHOWN_COMMITS = 3;

/** A delegated chat's own branch (mockups/chat-child-merge.html): its commits and a merge into the lead's. */
function BranchBlock({ threadId, branch, onChanged, onMention, working, onDiscarded }: {
  threadId: string;
  branch: Delegated;
  onChanged: () => void;
  onMention?: (text: string) => void;
  working: boolean;
  onDiscarded?: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  const [error, setError] = useState<string | null>(null);
  const [merged, setMerged] = useState<string | null>(null);
  const { commits, uncommitted, into } = branch;
  const conflicts = error ? conflictFiles(error) : [];
  const upToDate = commits.length === 0;

  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      setMerged(await mergeChildChat(threadId));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const loses = [
    commits.length > 0 && `${commits.length} ${commits.length === 1 ? "commit" : "commits"}`,
    uncommitted > 0 && `${uncommitted} ${uncommitted === 1 ? "file" : "files"}`,
  ].filter(Boolean).join(" and ");
  // mockups/chat-discard-branch.html, option A: two presses, and gone with its work.
  const discard = async () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    setBusy(true);
    setDiscardError(null);
    try {
      const gone = await discardChildChat(threadId);
      onDiscarded?.(`Discarded ${gone} · ${loses}`);
    } catch (reason) {
      setDiscardError(message(reason));
      setBusy(false);
    }
  };

  let chip = <span className="chat-branch-chip">{commits.length} ahead</span>;
  if (conflicts.length > 0) chip = <span className="chat-branch-chip" data-tone="bad">conflict</span>;
  else if (uncommitted > 0) chip = <span className="chat-branch-chip" data-tone="warn">{uncommitted} uncommitted</span>;
  else if (upToDate) chip = <span className="chat-branch-chip" data-tone="ok">up to date</span>;

  return (
    <section className="chat-branch" aria-label="Branch">
      <div className="chat-branch-head">
        <span className="chat-branch-glyph" data-tone={upToDate && uncommitted === 0 ? "ok" : undefined}>
          {upToDate && uncommitted === 0 ? <Check size={14} aria-hidden /> : <GitBranch size={14} aria-hidden />}
        </span>
        <span className="chat-branch-names">
          <code>{branch.branch}</code>
          <small>
            {merged && upToDate ? "merged into " : "into "}
            <code>{into}</code>
            {merged && upToDate && (
              <>
                {" "}as <code>{merged}</code>
              </>
            )}
          </small>
        </span>
        {chip}
      </div>
      {!upToDate && (
        <ul className="chat-branch-rail">
          {commits.slice(0, SHOWN_COMMITS).map((line) => {
            const at = line.indexOf(" ");
            return (
              <li key={line}>
                <code>{line.slice(0, at)}</code>
                <span>{line.slice(at + 1)}</span>
              </li>
            );
          })}
          {commits.length > SHOWN_COMMITS && <li data-more>{commits.length - SHOWN_COMMITS} more</li>}
        </ul>
      )}
      {error && (
        <div className="chat-branch-notice" role="alert">
          <b>Not merged</b>
          {conflicts.length > 0 ? (
            <>
              {into} changed the same lines in
              <span className="chat-branch-files">
                {conflicts.map((f) => (
                  <code key={f}>{f}</code>
                ))}
              </span>
            </>
          ) : (
            error
          )}
        </div>
      )}
      {discardError && (
        <div className="chat-branch-notice" role="alert">
          <b>Not discarded</b>
          {discardError}
        </div>
      )}
      {(!upToDate || uncommitted > 0) && (
        <div className="chat-branch-actions">
          <span>{!upToDate && uncommitted > 0 ? `Commit the ${uncommitted} ${uncommitted === 1 ? "file" : "files"} below first` : ""}</span>
          {onDiscarded && !working && (
            <button
              type="button"
              className="chat-btn chat-btn--ghost chat-branch-discard"
              data-armed={armed || undefined}
              disabled={busy}
              title="Delete this chat, its worktree and its branch"
              onClick={() => void discard()}
            >
              {armed ? `Discard ${loses}?` : "Discard…"}
            </button>
          )}
          {conflicts.length > 0 && onMention && (
            <button
              type="button"
              className="chat-btn chat-btn--ghost"
              onClick={() =>
                onMention(`Rebase ${branch.branch} onto ${into}, resolve the conflicts in ${conflicts.join(", ")}, run the tests and commit.`)
              }
            >
              Ask to rebase
            </button>
          )}
          {!upToDate && (
            <button type="button" className="chat-changes-commit" disabled={busy || uncommitted > 0} onClick={() => void merge()}>
              <GitMerge size={13} aria-hidden />
              {conflicts.length > 0 ? "Try again" : `Merge into ${into}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function toggled(set: Set<string>, path: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(path);
  else next.delete(path);
  return next;
}

function toggledAll(set: Set<string>, files: ChangedFile[], on: boolean): Set<string> {
  const next = new Set(set);
  for (const f of files) if (on) next.add(f.path);
  else next.delete(f.path);
  return next;
}

const FOLD_OVER = 10;

interface GroupProps {
  title: string;
  hint: string;
  files: ChangedFile[];
  picks: Set<string>;
  onPickAll: (on: boolean) => void;
  agent?: boolean;
  folded?: boolean;
  /** Absent: the group cannot fold (the agent's own, or while filtering). */
  onFold?: () => void;
}

function Group({ title, hint, files, picks, onPickAll, agent, folded = false, onFold }: GroupProps) {
  const count = files.filter((f) => picks.has(f.path)).length;
  const all = count === files.length;
  const label = (
    <>
      {agent && <span className="chat-changes-group-dot" aria-hidden />}
      {title}
      <span className="chat-changes-group-count">{files.length}</span>
    </>
  );
  return (
    <div className="chat-changes-group">
      <input
        type="checkbox"
        className="chat-changes-check"
        aria-label={`Select all: ${title}`}
        checked={all}
        ref={(el) => {
          if (el) el.indeterminate = count > 0 && !all;
        }}
        onChange={() => onPickAll(!all)}
      />
      {onFold ? (
        <button type="button" className="chat-changes-group-name" aria-expanded={!folded} onClick={onFold}>
          {label}
          <ChevronRight size={12} className="chat-changes-chevron" aria-hidden />
        </button>
      ) : (
        <span className="chat-changes-group-name">{label}</span>
      )}
      <span className="chat-changes-group-hint">
        {!agent && <Lock size={11} aria-hidden />}
        {hint}
      </span>
    </div>
  );
}

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D" } as const;

/** Five cells split by the share of added vs removed lines, like a review tool's diffstat. */
function DiffStat({ added, removed }: { added: number | null; removed: number | null }) {
  const total = (added ?? 0) + (removed ?? 0);
  const a = total ? Math.round(((added ?? 0) / total) * 5) : 0;
  const d = total ? Math.min(5 - a, Math.round(((removed ?? 0) / total) * 5)) : 0;
  return (
    <span className="chat-changes-stat" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} data-kind={i < a ? "add" : i < a + d ? "del" : undefined} />
      ))}
    </span>
  );
}

interface FileSectionProps {
  threadId: string;
  /** The drawer is open: only then is a diff read. */
  shown: boolean;
  file: ChangedFile;
  picked: boolean;
  open: boolean;
  /** true: viewed at this revision; "moved": viewed, then changed again. */
  viewed: boolean | "moved";
  view: DiffView;
  onPick: (on: boolean) => void;
  onOpen: () => void;
  onViewed: (on: boolean) => void;
}

function FileSection({ threadId, shown, file, picked, open, viewed, view, onPick, onOpen, onViewed }: FileSectionProps) {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash > 0 ? file.path.slice(0, slash) : "";
  // Kept mounted once opened, so closing animates and reopening shows the diff at once.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return (
    <section
      className="chat-changes-file"
      data-path={file.path}
      data-picked={picked || undefined}
      data-open={open || undefined}
      data-viewed={viewed === true || undefined}
    >
      <div className="chat-changes-file-head">
        <input type="checkbox" className="chat-changes-check" checked={picked} aria-label={`Commit ${file.path}`} onChange={(event) => onPick(event.target.checked)} />
        <button type="button" className="chat-changes-file-open" aria-expanded={open} onClick={onOpen} title={`${file.path} · ${file.status}`}>
          <span className="chat-changes-status" data-status={file.status} aria-hidden>
            {STATUS_LETTER[file.status]}
          </span>
          <span className="chat-changes-file-name">{name}</span>
          {/* rtl + bdi: an ellipsis cuts the far end of the path, so the nearest folder stays readable */}
          {dir && (
            <span className="chat-changes-file-dir">
              <bdi>{dir}</bdi>
            </span>
          )}
          {file.agent && (file.yoursBefore || file.yoursAfter) && (
            <span className="chat-changes-badge" data-tone="yours">
              also yours
            </span>
          )}
          {viewed === "moved" && (
            <span className="chat-changes-badge" data-tone="moved" title="Changed since you marked it viewed">
              changed
            </span>
          )}
          <span className="chat-changes-file-counts">
            <Counts added={file.added} removed={file.removed} />
            <DiffStat added={file.added} removed={file.removed} />
          </span>
        </button>
        <button
          type="button"
          className="chat-changes-viewed"
          aria-pressed={viewed === true}
          aria-label={`Viewed ${file.path}`}
          aria-keyshortcuts="V"
          title={viewed === true ? "Viewed · V" : "Mark viewed · V"}
          onClick={() => onViewed(viewed !== true)}
        >
          {viewed === true ? <Check size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
        </button>
      </div>
      <div className="chat-changes-body">
        <div className="chat-changes-body-inner">
          {opened && (
            <FileDiff threadId={threadId} path={file.path} version={fileRevision(file)} active={shown && open} {...view} />
          )}
        </div>
      </div>
    </section>
  );
}

/** Rows drawn before "Show all": a lockfile or generated file can change tens of thousands of lines. */
const DIFF_ROWS_SHOWN = 600;
/** Edit requests already opened; module-wide, so a remounted diff does not open an old one again. */
const handledEdits = new WeakSet<object>();

/** Read again when the file's counts change; the old rows stay up meanwhile, so nothing flashes. */
function FileDiff({
  threadId,
  path,
  version,
  active,
  split,
  ignoreWhitespace,
  onMention,
  reviewNotes,
  onReviewNote,
  editNote,
}: { threadId: string; path: string; version: string; active: boolean } & DiffView) {
  const box = useRef<HTMLDivElement>(null);
  // The Review note being written or edited: rows `from`..`to` of `rows`; `id` set when editing one.
  const [draft, setDraft] = useState<{ id: string | null; from: number; to: number; text: string } | null>(null);
  const anchor = useRef(0);
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    getChatChangeDiff(threadId, path, ignoreWhitespace).then(
      (diff) => {
        if (!live) return;
        const next = parseDiff(diff);
        // A draft holds row indexes of the old rows: move it to the same lines, keep its text.
        const old = rowsRef.current;
        setDraft((d) => d && old && moveDraft(d, reviewNote(path, old.slice(d.from, d.to + 1), ""), next));
        setRows(next);
        setError(null);
      },
      (reason: unknown) => live && setError(message(reason)),
    );
    return () => {
      live = false;
    };
  }, [threadId, path, version, active, attempt, ignoreWhitespace]);
  const html = useMemo(() => {
    const out = new Map<DiffRow, string>();
    const lines = rows ? highlightRows(rows, languageOf(path)) : null;
    rows?.forEach((row, i) => lines?.[i] != null && out.set(row, lines[i]!));
    return out;
  }, [rows, path]);
  const index = useMemo(() => new Map(rows?.map((row, i) => [row, i])), [rows]);
  const notes = useMemo(() => (reviewNotes ?? []).filter((q) => q.review?.path === path), [reviewNotes, path]);
  const noteAt = useMemo(() => {
    const at = new Map<number, Quote>();
    for (const q of notes) for (const i of notedRows(rows ?? [], q.review!)) at.set(i, q);
    return at;
  }, [notes, rows]);
  const openNote = (q: Quote) => {
    const at = notedRows(rows ?? [], q.review!);
    if (!at.length) return;
    if (at.at(-1)! >= DIFF_ROWS_SHOWN) setAll(true);
    setDraft({ id: q.id, from: at[0]!, to: at.at(-1)!, text: q.review!.note });
  };
  // A card or a marker elsewhere asked for this note: open it once the rows are here.
  useEffect(() => {
    if (!editNote || !rows || handledEdits.has(editNote)) return;
    const q = notes.find((n) => n.id === editNote.id);
    if (!q) return;
    handledEdits.add(editNote);
    openNote(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request or the rows arriving opens it
  }, [editNote?.n, rows]);
  if (error)
    return (
      <LoadError
        text={error}
        onRetry={() => {
          setError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  if (!rows) return <LinesSkeleton label="Reading the diff" />;
  if (rows.length === 0) return <p className="chat-changes-loading">No text changes to show</p>;
  const shown = all ? rows : rows.slice(0, DIFF_ROWS_SHOWN);
  const pick = (i: number, widen: boolean) => {
    if (widen && draft && draft.id === null) return setDraft({ ...draft, from: Math.min(anchor.current, i), to: Math.max(anchor.current, i) });
    const q = noteAt.get(i);
    if (q) return openNote(q);
    anchor.current = i;
    setDraft({ id: null, from: i, to: i, text: "" });
  };
  const save = () => {
    if (!draft || !draft.text.trim() || !onReviewNote) return;
    onReviewNote(draft.id ? { kind: "edit", id: draft.id, note: draft.text.trim() } : { kind: "add", note: reviewNote(path, rows.slice(draft.from, draft.to + 1), draft.text.trim()) });
    setDraft(null);
  };
  const gutter = (i: number | undefined) =>
    onReviewNote && i !== undefined ? (
      <button
        type="button"
        className="chat-review-plus"
        data-noted={noteAt.has(i) || undefined}
        aria-label={`${noteAt.has(i) ? "Edit review note on" : "Add a review note on"} ${rows[i]?.kind === "del" ? "removed " : ""}line ${rows[i]?.line ?? ""}`}
        title={noteAt.has(i) ? "Edit review note" : "Review note · shift-click to widen"}
        onClick={(event) => pick(i, event.shiftKey)}
      >
        {noteAt.has(i) ? <MessageSquare size={11} aria-hidden /> : <Plus size={11} strokeWidth={2.4} aria-hidden />}
      </button>
    ) : null;
  const picked = (i: number | undefined) => (draft && i !== undefined && i >= draft.from && i <= draft.to) || undefined;
  const editor = (...at: (number | undefined)[]) =>
    draft && onReviewNote && at.includes(draft.to) ? (
      <ReviewNoteEditor
        key={draft.id ?? "new"}
        cite={reviewNoteRef(reviewNote(path, rows.slice(draft.from, draft.to + 1), ""))}
        text={draft.text}
        editing={draft.id !== null}
        onText={(text) => setDraft({ ...draft, text })}
        onSave={save}
        onCancel={() => setDraft(null)}
        onDelete={() => {
          if (draft.id) onReviewNote({ kind: "remove", id: draft.id });
          setDraft(null);
        }}
      />
    ) : null;
  return (
    <div
      ref={box}
      className="chat-changes-diff chat-code-hl"
      data-split={split || undefined}
      data-review={onReviewNote ? true : undefined}
      role="table"
      aria-label={`Diff of ${path}`}
    >
      {split
        ? splitRows(shown).map((pair, i) =>
            pair.kind === "hunk" ? (
              <div key={i} className="chat-changes-hunk" role="row">
                {pair.text}
              </div>
            ) : (
              <Fragment key={i}>
                <div className="chat-changes-pair" role="row">
                  <DiffSide row={pair.left} no={pair.left?.kind === "context" ? pair.left.old : pair.left?.line} html={html} at={pair.left ? index.get(pair.left) : undefined} gutter={gutter} picked={picked} noted={noteAt} />
                  <DiffSide row={pair.right} no={pair.right?.line} html={html} at={pair.right && pair.right !== pair.left ? index.get(pair.right) : undefined} gutter={gutter} picked={picked} noted={noteAt} />
                </div>
                {editor(pair.left ? index.get(pair.left) : undefined, pair.right ? index.get(pair.right) : undefined)}
              </Fragment>
            ),
          )
        : shown.map((row, i) =>
            row.kind === "hunk" ? (
              <div key={i} className="chat-changes-hunk" role="row">
                {row.text}
              </div>
            ) : (
              <Fragment key={i}>
                <div
                  className="chat-changes-line"
                  data-kind={row.kind}
                  data-line={row.kind === "del" ? undefined : row.line}
                  data-row={index.get(row)}
                  data-noted={noteAt.has(index.get(row)!) || undefined}
                  data-picked={picked(index.get(row))}
                  role="row"
                >
                  {gutter(index.get(row))}
                  <span className="chat-changes-no">{row.line}</span>
                  <span className="chat-changes-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</span>
                  <DiffCode row={row} html={html} />
                </div>
                {editor(index.get(row))}
              </Fragment>
            ),
          )}
      {shown.length < rows.length && (
        <div className="chat-changes-more">
          <span>{(rows.length - shown.length).toLocaleString("en-US")} more lines</span>
          <button type="button" className="chat-btn" onClick={() => setAll(true)}>
            Show all
          </button>
        </div>
      )}
      {onMention && (
        <SelectionToChat
          scope={box}
          path={path}
          onAdd={onMention}
          onReviewNote={
            onReviewNote
              ? (picks: number[]) => {
                  anchor.current = Math.min(...picks);
                  setDraft({ id: null, from: Math.min(...picks), to: Math.max(...picks), text: "" });
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function DiffCode({ row, html }: { row: DiffRow; html: Map<DiffRow, string> }) {
  const lit = html.get(row);
  // highlight.js escapes the source; only its own <span class> markup is in here.
  if (lit != null) return <span className="chat-changes-code" dangerouslySetInnerHTML={{ __html: lit }} />;
  return <span className="chat-changes-code">{row.text}</span>;
}

/** Rows of `rows` a Review note sits on: its cited lines, on the side it cites (new, or removed). */
/** A draft moved onto reloaded rows. shortcut: lines the agent removed drop the draft, text included; keep it aside if that bites. */
export function moveDraft<D extends { from: number; to: number }>(draft: D, cite: ReviewNote, rows: readonly DiffRow[]): D | null {
  const at = notedRows(rows, cite);
  return at.length ? { ...draft, from: at[0]!, to: at.at(-1)! } : null;
}

/** The rows a note covers, as one unbroken span, so a range over mixed lines marks every row in it. */
function notedRows(rows: readonly DiffRow[], n: ReviewNote): number[] {
  let first = -1;
  let last = -1;
  rows.forEach((r, i) => {
    if (r.kind === "hunk" || r.line == null || (r.kind === "del") !== n.removed) return;
    if (r.line < n.from || r.line > n.to) return;
    if (first < 0) first = i;
    last = i;
  });
  const at: number[] = [];
  for (let i = first; first >= 0 && i <= last; i++) if (rows[i]!.kind !== "hunk") at.push(i);
  return at;
}

/**
 * One half of a split row; only the new side carries `data-line`, so "Add to chat" cites the file as it is.
 * A context row sits on both sides but takes its gutter and `data-row` only on the left (`at` unset on the right).
 */
function DiffSide({ row, no, html, at, gutter, picked, noted }: {
  row: DiffRow | null;
  no: number | null | undefined;
  html: Map<DiffRow, string>;
  at?: number;
  gutter: (i: number | undefined) => ReactNode;
  picked: (i: number | undefined) => true | undefined;
  noted: Map<number, Quote>;
}) {
  if (!row) return <div className="chat-changes-side" data-kind="blank" />;
  const fresh = row.kind !== "del" && no === row.line;
  return (
    <div
      className="chat-changes-side"
      data-kind={row.kind}
      data-line={fresh ? row.line : undefined}
      data-row={at}
      data-noted={(at !== undefined && noted.has(at)) || undefined}
      data-picked={picked(at)}
    >
      {gutter(at)}
      <span className="chat-changes-no">{no}</span>
      <DiffCode row={row} html={html} />
    </div>
  );
}

function ReviewNoteEditor({ cite, text, editing, onText, onSave, onCancel, onDelete }: {
  cite: string;
  text: string;
  editing: boolean;
  onText: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="chat-review-editor" role="group" aria-label={`Review note on ${cite}`}>
      <div className="chat-review-cite">
        Review note on <code>{cite}</code>
      </div>
      <textarea
        className="chat-review-text"
        autoFocus
        value={text}
        placeholder="What should the agent change here?"
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave();
          }
        }}
      />
      <div className="chat-review-bar">
        <span className="chat-review-hint">⌘↵ save · Esc cancel · shift-click a line to widen</span>
        {editing && (
          <button type="button" className="chat-btn chat-btn--ghost chat-review-delete" onClick={onDelete}>
            Delete
          </button>
        )}
        <button type="button" className="chat-btn chat-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="chat-btn chat-btn--primary" disabled={!text.trim()} onClick={onSave}>
          {editing ? "Update" : "Add note"}
        </button>
      </div>
    </div>
  );
}

export function LinesSkeleton({ label }: { label: string }) {
  return (
    <div className="chat-skeleton" role="status" aria-label={label}>
      {[72, 88, 54, 80, 64].map((w) => (
        <span key={w} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

export function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="chat-load-error" role="status">
      <span className="chat-changes-error">{text}</span>
      <button type="button" className="chat-btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

interface UndoDialogProps {
  files: ChangedFile[];
  agentName: string;
  onCancel: () => void;
  onUndo: (paths: string[]) => Promise<void>;
}

function UndoDialog({ files, agentName, onCancel, onUndo }: UndoDialogProps) {
  const [picks, setPicks] = useState(() => new Set(files.filter(undoDefault).map((f) => f.path)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const count = useMemo(() => files.filter((f) => picks.has(f.path)).length, [files, picks]);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const what = (f: ChangedFile): { text: string; warn: boolean } => {
    // Also a file only a command turn changed: it may hold the user's own edit from meanwhile.
    if (!f.undoable) return { text: "Lotus can’t undo this one", warn: false };
    if (f.yoursAfter) return { text: "your later edits will be lost", warn: true };
    if (f.status === "added") return { text: "deleted", warn: true };
    return { text: "restored", warn: false };
  };

  return (
    <dialog
      ref={dialog}
      className="chat-changes-dialog"
      aria-labelledby="chat-undo-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h3 id="chat-undo-title">Undo {agentName}’s edits?</h3>
      <p>
        Back to how they were before {agentName}’s first edit in this chat. Files {agentName} never touched stay as they are. This cannot
        be undone.
      </p>
      <ul className="chat-changes-dialog-list">
        {files.map((f) => {
          const { text, warn } = what(f);
          return (
            <li key={f.path}>
              <label>
                <input
                  type="checkbox"
                  checked={picks.has(f.path)}
                  disabled={!f.undoable || busy}
                  onChange={(event) => setPicks((s) => toggled(s, f.path, event.target.checked))}
                />
                <span>{f.path}</span>
              </label>
              <span className="chat-changes-dialog-what" data-warn={warn || undefined}>
                {text}
              </span>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="chat-changes-error" role="alert">
          {error}
        </p>
      )}
      <div className="chat-changes-dialog-actions">
        <button type="button" className="chat-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-changes-undo"
          disabled={busy || count === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onUndo(files.filter((f) => picks.has(f.path)).map((f) => f.path));
            } catch (reason) {
              setError(message(reason));
              setBusy(false);
            }
          }}
        >
          Undo {count} {count === 1 ? "file" : "files"}
        </button>
      </div>
    </dialog>
  );
}
