"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Ellipsis, Plus, Search } from "lucide-react";
import { KawungLoader } from "./KawungLoader";
import { RailFooter } from "./RailFooter";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";
import { useSectionReturn } from "@/modules/workspace-shell/hooks/useSectionReturn";

/** Where the row sits in the Command Rail (plans/chat-command-rail/PLAN.md). Unset reads as "read". */
export type ThreadRowState = "ready" | "waiting" | "running" | "read";

export interface ThreadRow {
  id: string;
  title: string;
  /** The title as stored, when `title` is a tidied version of it: the tooltip shows this one. */
  fullTitle?: string;
  /** The folder the agent works in: the second line of every row, before the time. */
  folder: string;
  state?: ThreadRowState;
  /** Right-hand text: time since the turn ended, or since last activity. */
  time: string;
  /** While running: when the turn started, for the live elapsed clock. */
  runningSince?: number;
  /** Chats it delegated, drawn under it on a hairline spine (mockups/chat-delegation.html). */
  children?: ThreadRow[];
  /** A sub-agent the agent ran itself (D9): read-only, so no menu. */
  native?: boolean;
  /** An unsent draft's start (mockups/chat-rail-draft.html, A): a read row says "Draft" where its time was. */
  draft?: string;
}

export interface ThreadGroup {
  id: string;
  label: string;
  threads: ThreadRow[];
  /** A drawer (Archived, #291): its heading toggles it and counts its rows. */
  drawer?: { open: boolean; onToggle: () => void };
  /** Rows shown before "Show N more". */
  limit?: number;
}

/** Rename, archive and delete from a row (#291). The new chat's `useThreadActions` fits this. */
export interface ThreadRailActions {
  openMenu: (threadId: string, anchor: HTMLElement) => void;
  menuOpenFor: string | null;
  renaming: string | null;
  rowProps: (threadId: string) => Pick<React.HTMLAttributes<HTMLElement>, "onContextMenu" | "onKeyDown">;
  renameField: (threadId: string) => React.ReactNode;
  layer: React.ReactNode;
}

interface ThreadRailProps {
  groups: ThreadGroup[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread?: () => void;
  /** The window's nav rows. Same slot as the workspace rail — one sidebar, two contents. */
  navSlot?: React.ReactNode;
  /**
   * A section's own sidebar content (Automations), drawn in place of this rail's nav rows, header
   * and list while that section is open. Only the footer stays, so the window keeps one sidebar.
   */
  sectionSlot?: React.ReactNode;
  /** The new chat's start screen is open: the + button is lit. */
  newChatOpen?: boolean;
  threadActions?: ThreadRailActions;
}

const STATE_TEXT: Record<ThreadRowState, string> = {
  ready: "New result",
  waiting: "Waiting for you",
  running: "Running",
  read: "",
};

/**
 * The Chat mode Command Rail: threads arranged by what they need from you — Ready, Running,
 * Earlier — with a search field on top. The caller decides the groups; this draws them, holds
 * their order while the pointer is over the list, and slides rows to their new place after.
 */
export function ThreadRail({
  groups,
  activeThreadId,
  onSelectThread,
  onNewThread,
  navSlot,
  sectionSlot,
  newChatOpen,
  threadActions,
}: ThreadRailProps) {
  const { openSettings } = useLotusSettings();
  const returned = useSectionReturn(Boolean(sectionSlot));
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Leads whose finished sub-agents are unfolded.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  // While the pointer is over the list, rows keep the places they had when it arrived.
  const [held, setHeld] = useState<Map<string, string[]> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlideOnMove(listRef);

  const needle = query.trim().toLowerCase();
  const renderRow = (row: ThreadRow, depth: number): React.ReactNode => (
    <div key={row.id} className="ws-cmd-tree" data-depth={depth || undefined}>
      {threadActions?.renaming === row.id ? (
        threadActions.renameField(row.id)
      ) : (
        <RailRow row={row} active={row.id === activeThreadId} actions={row.native ? undefined : threadActions} onSelect={onSelectThread} />
      )}
      {row.children?.length ? (
        <div className="ws-cmd-branch" role="group" aria-label={`Delegated by ${row.title}`}>
          {(() => {
            // Finished sub-agents fold behind one "N done" toggle that stays put, so the same click
            // closes them again. The open one stays shown while folded. Searching shows everything.
            const done = needle ? [] : row.children.filter((child) => child.native && child.state !== "running" && child.state !== "waiting");
            const open = unfolded.has(row.id);
            const shownDone = open ? [] : done.filter((child) => child.id === activeThreadId);
            const hidden = open ? done.length : done.length - shownDone.length;
            return (
              <>
                {row.children.filter((child) => !done.includes(child)).map((child) => renderRow(child, depth + 1))}
                {shownDone.map((child) => renderRow(child, depth + 1))}
                {hidden > 0 ? (
                  <div className="ws-cmd-tree" data-depth={depth + 1}>
                    <button
                      type="button"
                      className="ws-cmd-fold"
                      aria-expanded={open}
                      aria-label={`${open ? "Hide" : "Show"} ${hidden} finished sub-agent${hidden === 1 ? "" : "s"}`}
                      onClick={() =>
                        setUnfolded((ids) => {
                          const next = new Set(ids);
                          if (!next.delete(row.id)) next.add(row.id);
                          return next;
                        })
                      }
                    >
                      <ChevronRight size={11} strokeWidth={2} aria-hidden />
                      {hidden} done
                    </button>
                  </div>
                ) : null}
                {open ? done.map((child) => renderRow(child, depth + 1)) : null}
              </>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
  const shown = (held ? holdOrder(groups, held) : groups).map((group) => ({
    ...group,
    threads: needle
      ? group.threads.flatMap((row) => matching(row, needle))
      : group.threads,
  }));

  return (
    <nav className="ws-card ws-rail" aria-label={sectionSlot ? "Sidebar" : "Threads"}>
      {/* A section (Automations, today) takes the nav rows' and the list's place: one sidebar,
          one context. Its own back row is the way out. The list is HIDDEN, not unmounted, so
          going back shows the same rows at once — rebuilding them from nothing was the blink. */}
      {sectionSlot}
      <div
        className="ws-rail-main"
        data-enter={returned ? "back" : undefined}
        hidden={Boolean(sectionSlot)}
        inert={Boolean(sectionSlot)}
      >
        {navSlot ? <div className="ws-rail-nav">{navSlot}</div> : null}
        <div className="ws-cmd-search">
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input
            id="thread-rail-search"
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search threads"
            aria-label="Search threads"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                rowButtons(listRef.current)[0]?.focus();
              } else if (event.key === "Escape") {
                // First Esc clears the search; the next one goes back to the conversation.
                if (query) setQuery("");
                else document.querySelector<HTMLElement>(COMPOSER)?.focus();
              }
            }}
          />
          <button
            type="button"
            className="ws-cmd-new"
            aria-label="New chat"
            title="New chat"
            aria-current={newChatOpen ? "page" : undefined}
            onClick={onNewThread}
          >
            <Plus size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <div
          className="ws-rail-list ws-cmd-list"
          ref={listRef}
          onPointerEnter={() => setHeld(new Map(groups.map((group) => [group.id, group.threads.map((row) => row.id)])))}
          onPointerLeave={() => setHeld(null)}
          onKeyDown={(event) => {
            // ↑ ↓ walk the rows shown; ↑ from the first and Esc return to the search field.
            const rows = rowButtons(listRef.current);
            const at = rows.indexOf(document.activeElement as HTMLElement);
            if (at < 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = at + (event.key === "ArrowDown" ? 1 : -1);
              (next < 0 ? searchRef.current : rows[Math.min(next, rows.length - 1)])?.focus();
            } else if (event.key === "Escape") {
              searchRef.current?.focus();
            }
          }}
        >
          {needle && shown.every((group) => group.threads.length === 0) ? (
            <p className="ws-cmd-empty">No thread matches “{query.trim()}”</p>
          ) : null}
          {shown.map((group) => {
            if (group.threads.length === 0) return null;
            const open = !group.drawer || group.drawer.open;
            const capped = !needle && group.limit !== undefined && !expanded.has(group.id) && group.threads.length > group.limit;
            const rows = capped ? group.threads.slice(0, group.limit) : group.threads;
            return (
              <section key={group.id} className="ws-cmd-section" aria-label={group.label}>
                {group.drawer ? (
                  <button type="button" className="ws-cmd-group ws-rail-drawer" aria-expanded={group.drawer.open} onClick={group.drawer.onToggle}>
                    <ChevronRight size={11} strokeWidth={2} aria-hidden />
                    {group.label}
                    <span className="ws-cmd-count">{group.threads.length}</span>
                  </button>
                ) : (
                  <h3 className="ws-cmd-group">
                    {group.label}
                    {/* A count only where rows are hidden behind "Show N more"; otherwise the rows say it. */}
                    {capped ? <span className="ws-cmd-count">{group.threads.length}</span> : null}
                  </h3>
                )}
                {open && rows.map((row) => renderRow(row, 0))}
                {open && capped ? (
                  <button
                    type="button"
                    className="ws-cmd-more"
                    onClick={() => setExpanded((ids) => new Set(ids).add(group.id))}
                  >
                    Show {group.threads.length - rows.length} more
                  </button>
                ) : null}
              </section>
            );
          })}
        </div>
        {threadActions?.layer}
      </div>

      <RailFooter onOpenSettings={() => openSettings({ from: "chat-rail" })} />
    </nav>
  );
}

/** The row if it or a chat under it matches the search, keeping only the branches that do. */
function matching(row: ThreadRow, needle: string): ThreadRow[] {
  const children = (row.children ?? []).flatMap((child) => matching(child, needle));
  const hit = `${row.title} ${row.folder}`.toLowerCase().includes(needle);
  return hit || children.length ? [{ ...row, children: hit ? row.children : children }] : [];
}

/** The conversation's message field, where Esc from an empty search goes back to. */
const COMPOSER = ".chat-main textarea, .chat-main [contenteditable='true']";

function rowButtons(list: HTMLElement | null): HTMLElement[] {
  return list ? [...list.querySelectorAll<HTMLElement>(".ws-cmd-item")] : [];
}

function RailRow({
  row,
  active,
  actions,
  onSelect,
}: {
  row: ThreadRow;
  active: boolean;
  actions?: ThreadRailActions;
  onSelect: (threadId: string) => void;
}) {
  const state = row.state ?? "read";
  // State outranks a draft: Approve, news and elapsed are more urgent; the open thread shows its own.
  const draft = state === "read" && !active && row.draft !== undefined;
  return (
    <div
      className="ws-rail-row ws-cmd-row"
      data-thread-row=""
      data-row-id={row.id}
      data-menu-open={actions?.menuOpenFor === row.id ? "" : undefined}
    >
      <button
        type="button"
        className="ws-cmd-item"
        data-state={state}
        data-native={row.native || undefined}
        data-draft={draft || undefined}
        aria-current={active ? "true" : undefined}
        title={[row.fullTitle ?? row.title, row.folder, draft ? `Draft: ${row.draft}` : ""].filter(Boolean).join(" · ")}
        aria-label={[row.native ? "Sub-agent" : "", row.title, row.folder, draft ? "draft" : STATE_TEXT[state]].filter(Boolean).join(", ")}
        onClick={() => onSelect(row.id)}
        {...actions?.rowProps(row.id)}
      >
        <span className="ws-cmd-lead" aria-hidden>
          {state === "running" ? <KawungLoader /> : null}
        </span>
        <span className="ws-cmd-body">
          <span className="ws-cmd-title">
            {row.title}
          </span>
          {/* Folder and time share the second line on every row, so the folder is never squeezed out by the title. */}
          <span className="ws-cmd-meta">
            <span className="ws-cmd-folder">{row.folder}</span>
            {/* A sub-agent has no time of its own; an empty time would still draw its "·". */}
            {draft || state === "waiting" || (state === "running" && row.runningSince !== undefined) || row.time ? <span className="ws-cmd-time" aria-hidden>
              {draft ? (
                "Draft"
              ) : state === "running" && row.runningSince !== undefined ? (
                <Elapsed since={row.runningSince} />
              ) : state === "waiting" ? (
                "Approve"
              ) : (
                row.time
              )}
            </span> : null}
          </span>
        </span>
      </button>
      {actions ? (
        <button
          type="button"
          className="ws-rail-row-more"
          aria-label="Thread actions"
          aria-haspopup="menu"
          aria-expanded={actions.menuOpenFor === row.id}
          onClick={(event) => actions.openMenu(row.id, event.currentTarget)}
        >
          <Ellipsis size={14} strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** "0:42", "12:05", "1:11:11": a running turn's clock, ticking on its own so the rail need not re-render. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  return <>{h ? `${h}:${pad(m)}:${pad(seconds % 60)}` : `${m}:${pad(seconds % 60)}`}</>;
}

/**
 * The groups with every row kept where it was when the hold began; rows that arrived since go to
 * the end of their current group. Exported for the test.
 */
export function holdOrder(groups: ThreadGroup[], held: Map<string, string[]>): ThreadGroup[] {
  const rows = new Map(groups.flatMap((group) => group.threads.map((row) => [row.id, row] as const)));
  const placed = new Set([...held.values()].flat());
  const heldGroups = new Set(held.keys());
  const byId = new Map(groups.map((group) => [group.id, group]));
  const order = [...held.keys(), ...groups.map((group) => group.id).filter((id) => !heldGroups.has(id))];
  return order.flatMap((id) => {
    const group = byId.get(id);
    const kept = (held.get(id) ?? []).flatMap((rowId) => rows.get(rowId) ?? []);
    const arrived = (group?.threads ?? []).filter((row) => !placed.has(row.id));
    if (!group && kept.length === 0) return [];
    return [{ ...(group ?? { id, label: id }), threads: [...kept, ...arrived] }];
  });
}

/** Rows slide from where they were to where they are (FLIP), keyed by thread id. */
function useSlideOnMove(listRef: React.RefObject<HTMLDivElement | null>) {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
    const next = new Map<string, number>();
    for (const row of list.querySelectorAll<HTMLElement>("[data-row-id]")) {
      const id = row.dataset.rowId ?? "";
      next.set(id, row.offsetTop);
      const before = tops.current.get(id);
      if (still || before === undefined || before === row.offsetTop || typeof row.animate !== "function") continue;
      row.animate([{ transform: `translateY(${before - row.offsetTop}px)` }, { transform: "none" }], {
        duration: 320,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
    }
    tops.current = next;
  });
}
