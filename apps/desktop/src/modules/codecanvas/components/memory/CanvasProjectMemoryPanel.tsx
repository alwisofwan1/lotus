"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, Search, X } from "lucide-react";
import type { CodeCanvasMemoryItem } from "@/lib/tauri/codecanvas";
import {
  countMemoryKinds,
  describeMemoryKind,
  groupMemoryItemsByKind,
} from "../../services/memory/codecanvas-memory-presentation";
import { CanvasMemoryComposer, type MemoryDraft } from "./CanvasMemoryComposer";
import { CanvasMemoryEmptyState } from "./CanvasMemoryEmptyState";
import { CanvasMemoryItemRow } from "./CanvasMemoryItemRow";

/** Long enough that a typed word settles, short enough that the list feels live. */
const SEARCH_DEBOUNCE_MS = 180;

/** How long the archive undo stays on offer. */
const UNDO_WINDOW_MS = 6_000;

/** Kinds offered as filters, in the order agents receive them. */
const FILTER_KINDS = ["constraint", "decision", "fact", "blocker", "handoff", "evidence", "summary", "note"] as const;

export interface CanvasProjectMemoryPanelProps {
  open: boolean;
  items: CodeCanvasMemoryItem[];
  loading: boolean;
  error: string | null;
  includeArchived: boolean;
  /** Injected so relative ages are deterministic under test. */
  now?: number;
  onSearch: (query: string) => void;
  onWrite: (input: MemoryDraft) => void;
  onArchive: (itemId: string) => void;
  onRestore: (itemId: string) => void;
  onSetPinned: (itemId: string, pinned: boolean) => void;
  onIncludeArchivedChange: (includeArchived: boolean) => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function CanvasProjectMemoryPanel({
  open,
  items,
  loading,
  error,
  includeArchived,
  now,
  onSearch,
  onWrite,
  onArchive,
  onRestore,
  onSetPinned,
  onIncludeArchivedChange,
  onClose,
}: CanvasProjectMemoryPanelProps) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  // Tags were rendered and then dropped on the floor: the row printed `#rules` as inert text, so
  // the one piece of provenance that groups memories ACROSS kinds could be read but not used.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerKind, setComposerKind] = useState<string | undefined>(undefined);
  const [undoItemId, setUndoItemId] = useState<string | null>(null);
  // Ages are relative and coarse, so one timestamp per panel open is enough (the popover unmounts
  // when closed). Read lazily so render stays pure.
  const [openedAt] = useState(() => Date.now());

  // ── Keyboard ────────────────────────────────────────────────────────────────
  // The rail is nine controls for ONE decision, so as plain tab stops it costs nine presses to
  // reach the composer past it. A roving tabindex makes the whole group a single stop and hands
  // the arrows the job of moving inside it — the toolbar pattern, which is what this is: a row of
  // toggle buttons where exactly one is current.
  const railRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [railCursor, setRailCursor] = useState(0);

  const moveRail = useCallback((delta: number | "first" | "last") => {
    const buttons = Array.from(
      railRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    if (buttons.length === 0) return;
    setRailCursor((current) => {
      const next =
        delta === "first" ? 0
        : delta === "last" ? buttons.length - 1
        // Wrap, so Down at the bottom reaches All rather than dead-ending. A nine-item list is
        // short enough that wrapping reads as continuous rather than disorienting.
        : (current + delta + buttons.length) % buttons.length;
      buttons[next]?.focus();
      return next;
    });
  }, []);

  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const handled: Record<string, () => void> = {
      ArrowDown: () => moveRail(1),
      ArrowUp: () => moveRail(-1),
      Home: () => moveRail("first"),
      End: () => moveRail("last"),
    };
    const run = handled[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  // `/` jumps to search from anywhere in the panel — the one shortcut every list-with-a-filter has
  // trained people to expect. Guarded so it never eats a slash someone is typing into a field.
  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };

  // Live search: the list must never look like the whole memory while it is really a result set.
  const searchRef = useRef(onSearch);
  useEffect(() => { searchRef.current = onSearch; }, [onSearch]);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const timer = setTimeout(() => searchRef.current(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // The undo offer is a courtesy, not a mode: it expires so the panel does not keep a stale one-click
  // restore pointed at an item the user has moved on from.
  useEffect(() => {
    if (!undoItemId) return;
    const timer = setTimeout(() => setUndoItemId(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [undoItemId]);

  const counts = useMemo(() => countMemoryKinds(items), [items]);
  const visible = useMemo(() => {
    let next = kindFilter ? items.filter((item) => item.kind === kindFilter) : items;
    if (tagFilter) next = next.filter((item) => item.tags.includes(tagFilter));
    return next;
  }, [items, kindFilter, tagFilter]);
  const groups = useMemo(() => groupMemoryItemsByKind(visible), [visible]);

  if (!open) return null;

  const searching = query.trim().length > 0;
  const timestamp = now ?? openedAt;

  const openComposer = (kind?: string) => {
    setComposerKind(kind);
    setComposerOpen(true);
  };

  const archive = (itemId: string) => {
    onArchive(itemId);
    setUndoItemId(itemId);
  };

  const undo = () => {
    if (!undoItemId) return;
    onRestore(undoItemId);
    setUndoItemId(null);
  };

  const totalLabel = searching
    ? `${visible.length} ${visible.length === 1 ? "hit" : "hits"}`
    : `${items.length}`;

  return (
    <aside
      className="canvas-memory-shell"
      aria-label="Project memory"
      aria-busy={loading || undefined}
      data-expanded={expanded}
      onKeyDown={onPanelKeyDown}
    >
      <div className="canvas-memory-head">
        <div className="canvas-memory-eyebrow">
          Project memory
          <span className="canvas-memory-count">
            {items.length}
            {includeArchived ? " · with archived" : ""}
          </span>
        </div>
        <div className="canvas-memory-head-actions">
          <button
            type="button"
            className="canvas-memory-iconbtn"
            aria-label={expanded ? "Collapse project memory" : "Expand project memory"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
          </button>
          <button
            type="button"
            className="canvas-memory-iconbtn"
            aria-label="Close project memory"
            onClick={onClose}
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>

      {error ? <p role="alert" className="canvas-memory-error">{error}</p> : null}

      <div className="canvas-memory-search" role="search">
        <Search size={13} aria-hidden />
        <input
          ref={searchInputRef}
          type="search"
          aria-label="Search memory"
          placeholder="Search memory"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears the query rather than closing the panel. Closing is what Escape does
            // to a dialog, but here the search IS the mode the user is in, and losing the whole
            // panel because you wanted to drop a filter is the kind of thing people stop trusting
            // the keyboard for. With an empty box it falls through to whatever owns the panel.
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        {searching ? (
          <span className="canvas-memory-hits" aria-live="polite">
            {totalLabel}
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>clear</button>
          </span>
        ) : null}
        {/* Scope, not kind. It used to sit in the kind rail wearing the same clothes as Rules and
            Facts, which made two different questions look like one list: "which kind am I reading"
            and "how far back does the list reach". They are also not mutually exclusive — archived
            can be on WHILE a kind is selected — so presenting them as siblings was a lie the eye
            had to unlearn. It lives with search now because both answer "what am I looking at". */}
        <button
          type="button"
          role="switch"
          aria-checked={includeArchived}
          className="canvas-memory-scope"
          onClick={() => onIncludeArchivedChange(!includeArchived)}
        >
          Archived
        </button>
      </div>

      {tagFilter ? (
        // Filter state the user set from inside a row has to be visible from outside it, or the
        // list looks short for no reason. One pill, one way out.
        <div className="canvas-memory-activefilter">
          <span>Tagged</span>
          <button
            type="button"
            /* Distinct from the row tag's own "Clear tag filter …": two controls that do the
               same thing in different places should not answer to the same name, or a screen
               reader user hears the option twice with no way to tell them apart. */
            aria-label={`Remove tag filter ${tagFilter}`}
            onClick={() => setTagFilter(null)}
          >
            #{tagFilter} <span aria-hidden>×</span>
          </button>
        </div>
      ) : null}

      {!expanded ? (
        <div className="canvas-memory-filters">
          <button
            type="button"
            className="canvas-memory-chip"
            aria-label="Filter all"
            aria-pressed={kindFilter === null}
            onClick={() => setKindFilter(null)}
          >
            All <span className="canvas-memory-chip-count">{items.length}</span>
          </button>
          {FILTER_KINDS.filter((kind) => (counts[kind] ?? 0) > 0).map((kind) => {
            const presentation = describeMemoryKind(kind);
            return (
              <button
                key={kind}
                type="button"
                className="canvas-memory-chip"
                aria-label={`Filter ${presentation.plural}`}
                aria-pressed={kindFilter === kind}
                onClick={() => setKindFilter(kind)}
              >
                <span className="canvas-memory-glyph" aria-hidden>{presentation.glyph}</span>
                {presentation.plural}
                <span className="canvas-memory-chip-count">{counts[kind]}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="canvas-memory-body">
        {expanded ? (
          <div
            className="canvas-memory-rail"
            ref={railRef}
            role="toolbar"
            aria-orientation="vertical"
            aria-label="Filter by kind"
            onKeyDown={onRailKeyDown}
          >
            <button
              type="button"
              className="canvas-memory-rail-item"
              aria-label="Filter all"
              aria-pressed={kindFilter === null}
              tabIndex={railCursor === 0 ? 0 : -1}
              onFocus={() => setRailCursor(0)}
              onClick={() => setKindFilter(null)}
            >
              <span aria-hidden />
              <span>All</span>
              <span className="canvas-memory-chip-count">{items.length}</span>
            </button>
            {FILTER_KINDS.map((kind, index) => {
              const presentation = describeMemoryKind(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  className="canvas-memory-rail-item"
                  aria-label={`Filter ${presentation.plural}`}
                  /* The collapsed chip view already hides kinds with nothing in them; the rail
                     showed all eight at equal weight, so six empty rows competed with the two
                     that had content. Keep them — the taxonomy is worth teaching, and an empty
                     kind is still a place to file something — but stop them leading the eye. */
                  data-empty={(counts[kind] ?? 0) === 0 || undefined}
                  aria-pressed={kindFilter === kind}
                  tabIndex={railCursor === index + 1 ? 0 : -1}
                  onFocus={() => setRailCursor(index + 1)}
                  onClick={() => setKindFilter(kind)}
                >
                  <span className="canvas-memory-glyph" aria-hidden>{presentation.glyph}</span>
                  <span>{presentation.plural}</span>
                  <span className="canvas-memory-chip-count">{counts[kind] ?? 0}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {visible.length === 0 ? (
          searching ? (
            <p className="canvas-memory-empty">No memory matches that search.</p>
          ) : (
            <CanvasMemoryEmptyState onSeed={openComposer} showAction={!composerOpen} />
          )
        ) : (
          <ul className="canvas-memory-list">
            {groups.map((group) => (
              <li key={group.kind}>
                {/* The single place a kind is named. It now carries the glyph and the kind colour
                    that used to be repeated on every card below it. */}
                <p className="canvas-memory-group" data-role={describeMemoryKind(group.kind).colorRole}>
                  <span className="canvas-memory-glyph" aria-hidden>
                    {describeMemoryKind(group.kind).glyph}
                  </span>
                  {group.label}
                  <span className="canvas-memory-group-note">
                    {group.reachesAgents ? "read by agents" : "yours only"}
                  </span>
                </p>
                <ul className="canvas-memory-list" style={{ overflow: "visible", padding: 0 }}>
                  {group.items.map((item) => (
                    <CanvasMemoryItemRow
                      key={item.id}
                      item={item}
                      now={timestamp}
                      onArchive={archive}
                      onRestore={onRestore}
                      onSetPinned={onSetPinned}
                      activeTag={tagFilter}
                      onFilterTag={(tag) => setTagFilter((current) => (current === tag ? null : tag))}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      {undoItemId ? (
        <div className="canvas-memory-undo" role="status">
          Archived.
          <button type="button" onClick={undo}>Undo</button>
        </div>
      ) : null}

      <div className="canvas-memory-foot">
        <CanvasMemoryComposer
          key={composerKind ?? "default"}
          open={composerOpen}
          initialKind={composerKind}
          onOpen={openComposer}
          onCancel={() => setComposerOpen(false)}
          onSubmit={(draft) => {
            onWrite(draft);
            setComposerOpen(false);
          }}
        />
      </div>
    </aside>
  );
}
