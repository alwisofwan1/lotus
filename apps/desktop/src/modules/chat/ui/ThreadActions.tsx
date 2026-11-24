"use client";

// Pin, rename, archive and delete from the rail (#291; mockups/lotus-chat.fig, page "07c Thread actions").
// One hook and one layer serve both rails: the shell's ThreadRail and this module's own /chat rail.

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import { folderName } from "../domain/rail";
import {
  archiveChatThread,
  deleteChatThread,
  listChatThreads,
  pinChatThread,
  regenerateChatTitle,
  renameChatThread,
  setChatAgentName,
  type ChatThread,
} from "../runtime/chat-runtime-client";
import { AGENT_NAMES } from "./ChatModel";
import { Dither } from "./Dither";
import type { ChatRail } from "./ChatPage";
import { clearComposerDraft } from "../domain/composer-draft";
import { agentRenameErrorText, checkAgentRename } from "../domain/agent-handle";

type Anchor = HTMLElement | { x: number; y: number };

export interface ThreadActions {
  /** Opens a row's menu beside the row, or at the pointer for a right-click. */
  openMenu: (threadId: string, anchor: Anchor) => void;
  menuOpenFor: string | null;
  renaming: string | null;
  /** The row's own handlers: right-click, and the menu key (or ⇧F10) on a focused row. */
  rowProps: (threadId: string) => {
    onContextMenu: (event: MouseEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
  /** A row being renamed draws this in place of itself. */
  renameField: (threadId: string) => React.ReactNode;
  /** Saves a typed title; `null` (Esc, click away) or an unchanged one does nothing. */
  rename: (threadId: string, title: string | null) => void;
  /** Asks the model for a new title; `regenerating` holds the threads it is naming. */
  regenerate: (threadId: string) => void;
  regenerating: ReadonlySet<string>;
  /** The menu, the delete confirm and any error. Render once per rail. */
  layer: React.ReactNode;
  /** Pins the thread to the top of the rail, or unpins it (plans/chat-thread-pin). */
  togglePin: (threadId: string) => void;
  /** Deletes the thread (its session is stopped first) and drops it from the rail. */
  remove: (threadId: string) => Promise<void>;
  /** Renames the chat's agent (ADR-0068); returns why a name was refused, or null. */
  renameAgent: (threadId: string, name: string) => string | null;
  /** The chat whose header name field the menu's "Rename agent…" opened, with a count to reopen it. */
  agentEditing: { id: string; n: number } | null;
}

// togglePin runs only from a click, but the React Compiler lint cannot tell a handler returned from
// a hook from render code and flags a direct Date.now() there.
const pinStamp = () => Date.now();

export function useThreadActions({ threads, setThreads, activeId, setActiveId }: ChatRail): ThreadActions {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; from: HTMLElement | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [agentEditing, setAgentEditing] = useState<{ id: string; n: number } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Threads whose title is being regenerated: a Codex one takes ~10 s, and the menu says so meanwhile.
  const [regenerating, setRegenerating] = useState<ReadonlySet<string>>(new Set());

  // Optimistic: the rail changes at once; afterwards it shows what is stored, and a failure says why.
  const change = (id: string, patch: Partial<ChatThread>, call: Promise<void>) => {
    setThreads((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    void call
      .catch((reason: unknown) => setError(String(reason)))
      .then(() => listChatThreads().then(setThreads, () => {}));
  };

  const togglePin = (id: string) => {
    const thread = threads.find((t) => t.id === id);
    if (!thread || thread.archived) return;
    const pinned = !thread.pinnedAt;
    change(id, { pinnedAt: pinned ? pinStamp() : null }, pinChatThread(id, pinned));
  };

  const openMenu = (id: string, anchor: Anchor) => {
    setError(null);
    if (anchor instanceof HTMLElement) {
      const row = anchor.closest<HTMLElement>("[data-thread-row]") ?? anchor;
      const rect = row.getBoundingClientRect();
      setMenu({ id, x: rect.right + 8, y: rect.top - 4, from: anchor });
    } else {
      setMenu({ id, ...anchor, from: null });
    }
  };
  const closeMenu = () => {
    menu?.from?.focus();
    setMenu(null);
  };

  const menuThread = threads.find((t) => t.id === menu?.id) ?? null;
  const deleteThread = threads.find((t) => t.id === deleting) ?? null;

  const remove = async (threadId: string) => {
    await deleteChatThread(threadId);
    clearComposerDraft(threadId);
    setThreads((list) => list.filter((t) => t.id !== threadId));
    if (activeId === threadId) setActiveId(null);
  };

  const regenerate = (id: string) => {
    setRegenerating((ids) => new Set(ids).add(id));
    void regenerateChatTitle(id)
      .then(() => listChatThreads().then(setThreads, () => {}))
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setRegenerating((ids) => new Set([...ids].filter((x) => x !== id))));
  };

  const rename = (id: string, title: string | null) => {
    const thread = threads.find((t) => t.id === id);
    if (!thread || title === null || title === (thread.title ?? "")) return;
    change(id, title.trim() ? { title: title.trim() } : {}, renameChatThread(id, title));
  };

  const renameAgent = (id: string, name: string): string | null => {
    const thread = threads.find((t) => t.id === id);
    const check = thread ? checkAgentRename(threads, thread, name) : null;
    if (!check) return null;
    if ("error" in check) return agentRenameErrorText(check.error);
    change(id, { agentName: check.name }, setChatAgentName(id, check.name));
    return null;
  };

  const act = (action: MenuAction) => {
    if (!menuThread) return;
    setMenu(null);
    if (action === "rename") setRenaming(menuThread.id);
    else if (action === "rename-agent") {
      setActiveId(menuThread.id);
      setAgentEditing((was) => ({ id: menuThread.id, n: (was?.n ?? 0) + 1 }));
    }
    else if (action === "retitle") regenerate(menuThread.id);
    else if (action === "delete") setDeleting(menuThread.id);
    else if (action === "pin") togglePin(menuThread.id);
    else change(menuThread.id, { archived: !menuThread.archived, ...(menuThread.archived ? {} : { pinnedAt: null }) }, archiveChatThread(menuThread.id, !menuThread.archived));
  };

  return {
    remove,
    togglePin,
    renameAgent,
    agentEditing,
    openMenu,
    menuOpenFor: menu?.id ?? null,
    renaming,
    rename,
    regenerate,
    regenerating,
    rowProps: (threadId) => ({
      onContextMenu: (event) => {
        event.preventDefault();
        openMenu(threadId, { x: event.clientX, y: event.clientY });
      },
      onKeyDown: (event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          openMenu(threadId, event.currentTarget);
        }
      },
    }),
    renameField: (threadId) => {
      const thread = threads.find((t) => t.id === threadId);
      if (!thread || renaming !== threadId) return null;
      return (
        <RenameField
          thread={thread}
          onDone={(title) => {
            setRenaming(null);
            rename(threadId, title);
          }}
        />
      );
    },
    layer: (
      <>
        {menu && menuThread ? (
          <ThreadMenu thread={menuThread} at={menu} regenerating={regenerating.has(menuThread.id)} onAct={act} onClose={closeMenu} />
        ) : null}
        {deleteThread ? (
          <DeleteConfirm
            thread={deleteThread}
            onCancel={() => setDeleting(null)}
            onDelete={async () => {
              await remove(deleteThread.id);
              setDeleting(null);
            }}
          />
        ) : null}
        {error ? (
          <p className="chat-thread-error" role="alert" onClick={() => setError(null)}>
            {error}
          </p>
        ) : null}
      </>
    ),
  };
}


type MenuAction = "pin" | "rename" | "rename-agent" | "retitle" | "archive" | "delete";

function ThreadMenu({
  thread,
  at,
  regenerating,
  onAct,
  onClose,
}: {
  thread: ChatThread;
  at: { x: number; y: number };
  regenerating: boolean;
  onAct: (action: MenuAction) => void;
  onClose: () => void;
}) {
  // An API chat is not titled by a model: its prompt stays with the provider the user picked.
  const titledByModel = !thread.archived && thread.runner !== "api";
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
    const key = event.key.toLowerCase();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (key === "escape" || key === "tab") onClose();
    else if (key === "arrowdown") items[(i + 1) % items.length]?.focus();
    else if (key === "arrowup") items[(i - 1 + items.length) % items.length]?.focus();
    else if (key === "p" && !thread.archived) onAct("pin");
    else if (key === "r") onAct("rename");
    else if (key === "n" && !thread.archived && thread.agentName) onAct("rename-agent");
    else if (key === "t" && titledByModel && !regenerating) onAct("retitle");
    else if (key === "e") onAct("archive");
    else if (key === "backspace" || key === "delete") onAct("delete");
    else return;
    event.preventDefault();
  };

  return createPortal(
    <div
      ref={ref}
      className="chat-thread-menu"
      role="menu"
      aria-label={`Actions for ${thread.title ?? folderName(thread.cwd)}`}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
    >
      {/* Names the thread, so you never rename or delete the wrong one. */}
      <div className="chat-thread-menu-head">
        <span className="chat-thread-menu-title">{thread.title ?? folderName(thread.cwd)}</span>
        <span className="chat-thread-menu-sub">
          {folderName(thread.cwd)} · {thread.archived ? "archived" : AGENT_NAMES[thread.runner]}
        </span>
      </div>
      {!thread.archived && <MenuItem label={thread.pinnedAt ? "Unpin" : "Pin"} keycap="P" onClick={() => onAct("pin")} />}
      {!thread.archived && <MenuItem label="Rename title…" keycap="R" onClick={() => onAct("rename")} />}
      {!thread.archived && thread.agentName && <MenuItem label="Rename agent…" keycap="N" onClick={() => onAct("rename-agent")} />}
      {titledByModel && (
        <MenuItem label={regenerating ? "Regenerating title…" : "Regenerate title"} keycap="T" disabled={regenerating} onClick={() => onAct("retitle")} />
      )}
      <MenuItem label={thread.archived ? "Unarchive" : "Archive"} keycap="E" onClick={() => onAct("archive")} />
      <MenuItem label="Delete…" keycap="⌫" danger onClick={() => onAct("delete")} />
    </div>,
    document.body,
  );
}

export function MenuItem({ label, keycap, danger, disabled, onClick }: { label: string; keycap: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="chat-thread-menu-item" data-danger={danger ? "" : undefined} disabled={disabled} onClick={onClick}>
      {label}
      {keycap && <kbd>{keycap}</kbd>}
    </button>
  );
}

/** The rename's underline: an even checker that fades out over the last fifth. */
export const band = (u: number) => (u < 0.8 ? 0.5 : (0.5 * (1 - u)) / 0.2);

function RenameField({ thread, onDone }: { thread: ChatThread; onDone: (title: string | null) => void }) {
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <div className="chat-thread-rename" data-thread-row="">
      <input
        className="chat-thread-rename-input"
        aria-label="Thread name"
        defaultValue={thread.title ?? ""}
        placeholder="First message’s line"
        maxLength={80}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") finish(event.currentTarget.value);
          else if (event.key === "Escape") finish(null);
          else return;
          event.preventDefault();
        }}
        // Clicking away cancels, as Esc does: nothing is renamed by accident.
        onBlur={() => finish(null)}
      />
      <Dither className="chat-thread-rename-line" field={band} cell={1} />
      <span className="chat-thread-rename-hint">
        <kbd>↵</kbd> save <kbd>esc</kbd> cancel
      </span>
    </div>
  );
}

/** A glow under the confirm's top edge. */
export const glow = (u: number, v: number) => Math.max(0, 1 - Math.hypot((u - 0.5) * 1.6, v * 2.2)) ** 1.4;

function DeleteConfirm({
  thread,
  onCancel,
  onDelete,
}: {
  thread: ChatThread;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = thread.title ?? folderName(thread.cwd);
  const remove = () => {
    setBusy(true);
    setError(null);
    onDelete().catch((reason: unknown) => {
      setBusy(false);
      setError(String(reason));
    });
  };
  return createPortal(
    <div className="chat-thread-scrim" onPointerDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <div
        className="chat-thread-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="chat-thread-confirm-title"
        aria-describedby="chat-thread-confirm-body"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
          // Two buttons; Tab stays between them.
          if (event.key === "Tab") {
            const buttons = [...event.currentTarget.querySelectorAll("button")];
            const next = buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + 1) % buttons.length];
            next?.focus();
            event.preventDefault();
          }
        }}
      >
        <Dither className="chat-thread-confirm-glow" field={glow} />
        <h2 id="chat-thread-confirm-title" className="chat-thread-confirm-title">
          Delete “{name}”?
        </h2>
        <p id="chat-thread-confirm-body" className="chat-thread-confirm-body">
          {error ?? (
            <>
              {thread.status === "working" ? "Its running turn stops, and its" : "Its"} history goes for good. Files in{" "}
              {folderName(thread.cwd)} aren’t touched.
            </>
          )}
        </p>
        <div className="chat-thread-confirm-actions">
          <button type="button" className="chat-thread-confirm-cancel" autoFocus disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="chat-thread-confirm-delete" disabled={busy} onClick={remove}>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
