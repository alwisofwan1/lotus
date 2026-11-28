"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Pin, Plus, Search, Trash2 } from "lucide-react";
import { useCanvasOcclusionLock } from "../../hooks/useCanvasOcclusionLock";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";
import type { CanvasSessionRecord } from "../../services/session-record";
import {
  filterSessions,
  groupSessionsByTime,
  sessionMetaLine,
  sessionRowTitle,
} from "../../services/session-view";
import { deleteDecision, deletedNoticeText } from "../../services/session-delete";

/** Marks the button that opens a list, so pressing it is a toggle and not an outside click. */
export const SESSION_LIST_TOGGLE_ATTR = "data-session-list-toggle";

export interface SessionNeedsYou {
  headline?: string;
}

export interface SessionListConfirm {
  /** The pressed row; null for a question with no row ("New conversation"). */
  sessionId: string | null;
  text: string;
  onAnswer: (go: boolean) => void;
}

export interface CanvasSessionListProps {
  /** Rows to show, already scoped (project or node) by the caller. */
  sessions: CanvasSessionRecord[];
  /** Dialog name, e.g. "Sessions" or "Rei's sessions". */
  label: string;
  searchPlaceholder: string;
  /** Small text at the end of the search field saying what is being searched. */
  scopeLabel?: string;
  loading?: boolean;
  error?: string | null;
  /** Injected so ages and day bands are deterministic under test. */
  now?: number;
  /** The agent's handle for a row; shown in its meta line and matched by search. */
  agentName?: (session: CanvasSessionRecord) => string | undefined;
  /** The conversation the node is in right now (node list only). */
  currentSessionId?: string | null;
  /** The agent behind this row is waiting on a human: an amber row that sorts first in Running. */
  needsYou?: (session: CanvasSessionRecord) => SessionNeedsYou | undefined;
  /**
   * A switch waiting on "Switch anyway / Stay", asked inside the row that was pressed (above the
   * list when that row is not in it, e.g. "New conversation"). Enter and Esc answer Stay.
   */
  confirm?: SessionListConfirm | null;
  /** Whether a press does anything. A row that cannot be opened stays readable, not pressable. */
  canOpen: (session: CanvasSessionRecord) => boolean;
  onOpen: (session: CanvasSessionRecord) => void;
  /** Node list only: a fresh conversation on this node. */
  onNewConversation?: () => void;
  onTogglePinned?: (session: CanvasSessionRecord, pinned: boolean) => void;
  /** Forget a row. Lotus's record only — the runner's transcript stays on disk. */
  onDelete?: (session: CanvasSessionRecord) => void;
  pendingDelete?: CanvasSessionRecord | null;
  onUndoDelete?: () => void;
  /** Text for an empty list with no query. */
  emptyText: string;
  className?: string;
  onClose: () => void;
}

/**
 * One list for every place sessions are shown (2026-11-13 refactor, `mockups/canvas-sessions.html`):
 * the ⋯ menu opens it over the whole project, a node's header chip opens it over that node.
 *
 * A press is always "Open" — what that means (focus, wake, relaunch, a new node) stays the
 * dispatcher's decision. Pin and Delete live behind a row's own ⋯ so the row itself has one action.
 */
export function CanvasSessionList({
  sessions,
  label,
  searchPlaceholder,
  scopeLabel,
  loading = false,
  error = null,
  now,
  agentName,
  currentSessionId,
  needsYou,
  confirm,
  canOpen,
  onOpen,
  onNewConversation,
  onTogglePinned,
  onDelete,
  pendingDelete,
  onUndoDelete,
  emptyText,
  className,
  onClose,
}: CanvasSessionListProps) {
  // A native Browser Node WebView paints above the whole DOM; an overlay that does not park it gets
  // covered by a web page. The list only exists while it is open, so the lock is held for its life.
  useCanvasOcclusionLock(true, "session-list");
  const shortcut = useFormatShortcut();
  // Mounted when it opens, so "now" is the moment it was opened — ages need not tick in a popover.
  const [openedAt] = useState(() => Date.now());
  const timestamp = now ?? openedAt;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const groups = useMemo(() => {
    const banded = groupSessionsByTime(filterSessions(sessions, query, agentName), timestamp);
    if (!needsYou) return banded;
    // A waiting agent is the reason to open the list: its row leads Running (sort is stable).
    return banded.map((g) =>
      g.key === "running"
        ? { ...g, sessions: [...g.sessions].sort((a, b) => Number(!!needsYou(b)) - Number(!!needsYou(a))) }
        : g,
    );
  }, [sessions, query, agentName, timestamp, needsYou]);
  const flat = useMemo(() => groups.flatMap((g) => g.sessions), [groups]);
  const active = flat[Math.min(selected, flat.length - 1)];

  // Clicking anywhere else closes the list — except its own opener, which toggles it.
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (rootRef.current?.contains(target) || target?.closest?.(`[${SESSION_LIST_TOGGLE_ATTR}]`)) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [onClose]);

  const open = (session: CanvasSessionRecord | undefined) => {
    if (!confirm && session && canOpen(session)) onOpen(session);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (confirm) {
      // Stay is the default: the destructive answer is never one keystroke away.
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        confirm.onAnswer(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((i) => Math.max(0, Math.min(flat.length - 1, i + step)));
      setMenuFor(null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      open(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (menuFor) setMenuFor(null);
      else if (query) setQuery("");
      else onClose();
    } else if (onNewConversation && event.key.toLowerCase() === "n" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onNewConversation();
    }
  };

  const filteredToNothing = flat.length === 0 && sessions.length > 0;
  const ask = (row: React.ReactNode) =>
    confirm ? (
      <div className="canvas-session-list-ask" role="alertdialog" aria-label="Switch conversation?" key="ask">
        {row}
        <p>{confirm.text}</p>
        <div className="canvas-session-list-ask-buttons">
          <button type="button" className="canvas-session-list-ask-go" onClick={() => confirm.onAnswer(true)}>
            Switch anyway
          </button>
          <button
            type="button"
            className="canvas-session-list-ask-stay"
            autoFocus
            onClick={() => confirm.onAnswer(false)}
          >
            Stay <kbd>↵</kbd>
          </button>
        </div>
      </div>
    ) : null;
  const confirmRowShown = Boolean(confirm?.sessionId && flat.some((s) => s.id === confirm.sessionId));

  return (
    <div
      ref={rootRef}
      className={`canvas-session-list nodrag nowheel nopan${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      <label className="canvas-session-list-search">
        <Search size={14} aria-hidden />
        <input
          type="text"
          className="canvas-session-list-input"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
          // The list is opened to find something; typing should not need a click first.
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
        />
        {scopeLabel ? <span className="canvas-session-list-scope">{scopeLabel}</span> : null}
      </label>

      {onNewConversation && !query ? (
        <button type="button" className="canvas-session-list-new" onClick={onNewConversation}>
          <Plus size={14} aria-hidden />
          <span>New conversation</span>
          <kbd>{shortcut("⌘N")}</kbd>
        </button>
      ) : null}

      {error ? <p className="canvas-session-list-error">{error}</p> : null}
      {confirm && !confirmRowShown ? ask(null) : null}

      <div className="canvas-session-list-body" id={listId} role="listbox" aria-label={label}>
        {flat.length === 0 ? (
          <p className="canvas-session-list-empty">
            {loading && !sessions.length
              ? "Loading…"
              : filteredToNothing
                ? `No sessions match “${query.trim()}”.`
                : emptyText}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              <p className="canvas-session-list-band" aria-hidden>
                {group.label}
              </p>
              {group.sessions.map((session) => {
                const index = flat.indexOf(session);
                const pressable = canOpen(session);
                const title = sessionRowTitle(session);
                const name = agentName?.(session);
                const current = session.id === currentSessionId;
                const deletable = Boolean(onDelete) && deleteDecision(session).allowed;
                const hasMenu = (Boolean(onTogglePinned) || deletable) && !confirm;
                const waiting = needsYou?.(session);
                const asking = confirm?.sessionId === session.id;
                const row = (
                  <div
                    key={session.id}
                    id={`${listId}-${session.id}`}
                    role="option"
                    aria-selected={session === active}
                    aria-disabled={!pressable || undefined}
                    aria-current={current ? "true" : undefined}
                    aria-label={title}
                    className="canvas-session-list-row"
                    data-status={session.status}
                    data-needs-you={waiting ? "" : undefined}
                    onMouseMove={() => index !== selected && setSelected(index)}
                    onClick={() => open(session)}
                  >
                    <span className="canvas-session-list-dot" aria-hidden />
                    <span className="canvas-session-list-text">
                      <span className="canvas-session-list-title">{title}</span>
                      <span className="canvas-session-list-meta">
                        {waiting ? (
                          <>
                            <b className="canvas-session-list-needs-you">Needs you</b>
                            {" · "}
                            {waiting.headline ? `${waiting.headline} · ` : ""}
                          </>
                        ) : null}
                        {session.status === "dead" ? "Can't be resumed · " : ""}
                        {sessionMetaLine(session, timestamp, name)}
                        {session.pinned ? <Pin size={10} aria-label="Pinned" /> : null}
                      </span>
                    </span>
                    {current ? <span className="canvas-session-list-current">Current</span> : null}
                    <span className="canvas-session-list-actions">
                      {pressable && !current && !confirm ? (
                        <span className="canvas-session-list-open" aria-hidden>
                          Open <kbd>↵</kbd>
                        </span>
                      ) : null}
                      {hasMenu ? (
                        <button
                          type="button"
                          className="canvas-session-list-more"
                          aria-label={`Options for ${title}`}
                          aria-haspopup="menu"
                          aria-expanded={menuFor === session.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuFor((id) => (id === session.id ? null : session.id));
                          }}
                        >
                          <MoreHorizontal size={15} aria-hidden />
                        </button>
                      ) : null}
                    </span>
                    {menuFor === session.id ? (
                      <div className="canvas-session-list-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                        {onTogglePinned ? (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              onTogglePinned(session, !session.pinned);
                            }}
                          >
                            <Pin size={13} aria-hidden /> {session.pinned ? "Unpin" : "Pin"}
                          </button>
                        ) : null}
                        {deletable ? (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              className="canvas-session-list-danger"
                              onClick={() => {
                                setMenuFor(null);
                                onDelete?.(session);
                              }}
                            >
                              <Trash2 size={13} aria-hidden /> Delete
                            </button>
                            <small>Removes it from Lotus. The transcript stays on disk.</small>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
                return asking ? ask(row) : row;
              })}
            </div>
          ))
        )}
      </div>

      {pendingDelete && onUndoDelete ? (
        <div className="canvas-session-list-undo" role="status">
          <span>{deletedNoticeText(pendingDelete)}. Transcript kept.</span>
          <button type="button" onClick={onUndoDelete}>
            Undo
          </button>
        </div>
      ) : (
        <div className="canvas-session-list-foot" aria-hidden>
          <span>
            <kbd>↑↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
          </span>
          <span>
            {flat.length} {flat.length === 1 ? "session" : "sessions"}
          </span>
        </div>
      )}
    </div>
  );
}
