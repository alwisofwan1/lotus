"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { PATH_QUERY_DEBOUNCE_MS, rankPaths, type PathHit } from "@/modules/codespace/services/fuzzy-path";
import { formatRecentAge, type RecentFile } from "@/modules/codespace/services/recent-files";

/** An editor action run from the palette by typing `>`. */
export type PaletteCommand = {
  id: string;
  label: string;
  /** Its keyboard shortcut, shown at the end of the row. */
  hint?: string;
  run: () => void;
};

interface GoToFilePaletteProps {
  rootDir: string;
  /** Every file in the workspace; `null` while the index is being read. */
  files: readonly string[] | null;
  truncated: boolean;
  /** Why the file list could not be read, if it could not. */
  error?: string | null;
  /** Shown while the query is empty, newest first. The caller drops files that are gone. */
  recent?: readonly RecentFile[];
  /** Clock for the recent rows' ages; tests pin it. */
  now?: number;
  /** Listed when the query starts with `>`. */
  commands?: readonly PaletteCommand[];
  /** Text typed before the palette opened (the launcher's field). */
  initialQuery?: string;
  onOpen: (path: string, line?: number) => void;
  /** A command was picked. The caller closes the palette and runs it. */
  onCommand?: (command: PaletteCommand) => void;
  onClose: () => void;
}

const RECENT_LIMIT = 8;
// Stable defaults: a fresh `[]` per render would rebuild the list and drop the highlighted row.
const NO_RECENT: readonly RecentFile[] = [];
const NO_COMMANDS: readonly PaletteCommand[] = [];
const RESULT_LIMIT = 50;
const LINE_SUFFIX_RE = /^(.*?):(\d+)$/;

function splitLine(query: string): { text: string; line?: number } {
  const match = LINE_SUFFIX_RE.exec(query.trim());
  return match ? { text: match[1], line: Number(match[2]) } : { text: query };
}

/** `positions` count string units, so an emoji (two units) must not shift the marks after it. */
function withMarks(text: string, positions: readonly number[]): ReactNode[] {
  const marked = new Set(positions);
  const parts: ReactNode[] = [];
  let unit = 0;
  for (const char of text) {
    parts.push(marked.has(unit)
      ? <mark key={unit} className="bg-transparent font-bold text-[color:var(--codespace-panel-accent)]">{char}</mark>
      : <span key={unit}>{char}</span>);
    unit += char.length;
  }
  return parts;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[4px] bg-[color:var(--codespace-panel-surface-active)] px-1.5 font-mono text-[11px] text-[color:var(--codespace-panel-text-muted)]">
      {children}
    </kbd>
  );
}

function splitFolder(rootDir: string, path: string): { name: string; folder: string } {
  const root = rootDir.replace(/\/+$/, "");
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? { name: relative, folder: "" } : { name: relative.slice(slash + 1), folder: relative.slice(0, slash) };
}

type PaletteItem =
  | { kind: "file"; key: string; hit: PathHit }
  | { kind: "recent"; key: string; entry: RecentFile; name: string; folder: string }
  | { kind: "command"; key: string; command: PaletteCommand };

/**
 * ⌘P: find any file in the workspace by a few letters of its name or path. Empty: recent files.
 * `>`: editor commands.
 */
export function GoToFilePalette({
  rootDir,
  files,
  truncated,
  error = null,
  recent = NO_RECENT,
  now,
  commands = NO_COMMANDS,
  initialQuery = "",
  onOpen,
  onCommand,
  onClose,
}: GoToFilePaletteProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [settledQuery, setSettledQuery] = useState(initialQuery);
  const settleTimerRef = useRef<number | null>(null);
  // The palette lives for seconds: ages as of when it opened are right.
  const [openedAt] = useState(() => Date.now());

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    // Carry on typing after the launcher's text, not over it.
    input?.setSelectionRange(input.value.length, input.value.length);
    return () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    };
  }, []);

  const changeQuery = (next: string) => {
    setQuery(next);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    // The first letter answers at once, and so does a command filter (a short, fixed list);
    // later letters of a file search wait for a pause in typing.
    if (!settledQuery.trim() || !next.trim() || next.trimStart().startsWith(">")) {
      setSettledQuery(next);
      return;
    }
    settleTimerRef.current = window.setTimeout(() => setSettledQuery(next), PATH_QUERY_DEBOUNCE_MS);
  };

  const commandMode = settledQuery.trimStart().startsWith(">");
  const commandFilter = commandMode ? settledQuery.trimStart().slice(1).trim().toLowerCase() : "";
  const { text, line } = splitLine(commandMode ? "" : settledQuery);
  const hits: PathHit[] = useMemo(() => {
    if (commandMode || !files) return [];
    const search = splitLine(settledQuery).text;
    return search.trim() ? rankPaths(search, files, { rootDir, limit: RESULT_LIMIT }) : [];
  }, [commandMode, files, rootDir, settledQuery]);
  const showRecent = !commandMode && !text.trim() && recent.length > 0;
  const items: PaletteItem[] = useMemo(() => {
    if (commandMode) {
      return commands
        .filter((command) => command.label.toLowerCase().includes(commandFilter))
        .map((command) => ({ kind: "command", key: command.id, command }));
    }
    if (showRecent) {
      return recent.slice(0, RECENT_LIMIT).map((entry) => ({ kind: "recent", key: entry.path, entry, ...splitFolder(rootDir, entry.path) }));
    }
    return hits.map((hit) => ({ kind: "file", key: hit.path, hit }));
  }, [commandFilter, commandMode, commands, hits, recent, rootDir, showRecent]);

  // The highlighted row belongs to one list; a new list starts at the top.
  const [selection, setSelection] = useState<{ items: PaletteItem[]; index: number }>({ items, index: 0 });
  const active = selection.items === items ? selection.index : 0;
  const setActive = (update: (index: number) => number) => setSelection({ items, index: update(active) });

  const total = files ? `${files.length.toLocaleString()}${truncated ? "+" : ""}` : "";
  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.kind === "command") onCommand?.(item.command);
    else if (item.kind === "recent") onOpen(item.entry.path, undefined);
    else onOpen(item.hit.path, line);
  };
  const optionId = (index: number) => `${listId}-option-${index}`;
  const clock = now ?? openedAt;

  const renderItem = (item: PaletteItem, index: number) => {
    const selected = index === active;
    const label = item.kind === "command" ? item.command.label : item.kind === "recent" ? item.name : item.hit.name;
    return (
      <div
        key={item.key}
        id={optionId(index)}
        role="option"
        aria-label={label}
        aria-selected={selected}
        onMouseEnter={() => setActive(() => index)}
        onClick={() => pick(item)}
        className={cn(
          "flex h-[34px] cursor-default items-center gap-2.5 rounded-[6px] px-2.5 text-[13px]",
          selected && "bg-[color:var(--codespace-panel-accent-soft)]",
        )}
      >
        {item.kind === "command" ? (
          <>
            <span className="min-w-0 truncate text-[color:var(--codespace-panel-text)]">{item.command.label}</span>
            <span className="flex-1" />
            {item.command.hint ? <Kbd>{item.command.hint}</Kbd> : null}
            {selected ? <span className="text-[12px] text-[color:var(--codespace-panel-text-muted)]">↵</span> : null}
          </>
        ) : (
          <>
            <span className="shrink-0 text-[color:var(--codespace-panel-text)]">
              {item.kind === "file" ? withMarks(item.hit.name, item.hit.nameMatches) : item.name}
            </span>
            <span className="min-w-0 truncate text-[12px] text-[color:var(--codespace-panel-text-quiet)]" dir="rtl">
              {/* rtl + an isolate: a long folder is cut at its start, the end stays readable. */}
              <bdi>{item.kind === "file" ? item.hit.folder : item.folder}</bdi>
            </span>
            <span className="flex-1" />
            {item.kind === "recent" ? (
              <span className="shrink-0 text-[11px] text-[color:var(--codespace-panel-text-quiet)]">
                {selected ? "↵ open" : formatRecentAge(item.entry.at, clock)}
              </span>
            ) : selected ? (
              <span className="text-[12px] text-[color:var(--codespace-panel-text-muted)]">↵</span>
            ) : null}
          </>
        )}
      </div>
    );
  };

  const message = (() => {
    if (commandMode) return items.length === 0 ? `No command matches ${commandFilter}` : null;
    if (error) return null;
    if (files === null && !showRecent) return "Indexing files…";
    if (showRecent) return null;
    if (!text.trim()) return `Type to search ${total} files`;
    return hits.length === 0 ? `No file matches ${text.trim()}` : null;
  })();

  return (
    <div className="absolute inset-0 z-40 flex justify-center bg-black/45 px-4 pt-11" onMouseDown={onClose}>
      <div
        className="flex h-fit max-h-[70%] w-full max-w-[600px] flex-col overflow-hidden rounded-[10px] border border-[color:var(--codespace-panel-border)] bg-[color:var(--codespace-panel-surface-raised)] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[color:var(--codespace-panel-border)] px-3.5">
          <Search className="h-4 w-4 shrink-0 text-[color:var(--codespace-panel-text-muted)]" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Go to file"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={items.length > 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            value={query}
            placeholder="Go to file…"
            spellCheck={false}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              } else if (event.key === "ArrowDown" && items.length > 0) {
                event.preventDefault();
                setActive((index) => (index + 1) % items.length);
              } else if (event.key === "ArrowUp" && items.length > 0) {
                event.preventDefault();
                setActive((index) => (index - 1 + items.length) % items.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (query === settledQuery) {
                  pick(items[active]);
                  return;
                }
                // Typed faster than the list settles: answer what is in the box now.
                const typed = splitLine(query);
                const [first] = files && typed.text.trim() ? rankPaths(typed.text, files, { rootDir, limit: 1 }) : [];
                if (first) onOpen(first.path, typed.line);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[color:var(--codespace-panel-text)] outline-none placeholder:text-[color:var(--codespace-panel-text-quiet)]"
          />
          {!commandMode && hits.length > 0 ? (
            <span className="shrink-0 text-[11px] text-[color:var(--codespace-panel-text-quiet)]">{`${hits.length} of ${total}`}</span>
          ) : null}
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label={commandMode ? "Commands" : showRecent ? "Recent files" : "Files"}
          className="min-h-0 overflow-y-auto p-1.5"
        >
          {error && !commandMode ? (
            <p role="alert" className="px-2.5 py-2 text-[12px] text-amber-200/90">{`Could not list the files: ${error}`}</p>
          ) : null}
          {message ? (
            <p className="px-2.5 py-2 text-[12px] text-[color:var(--codespace-panel-text-muted)]">{message}</p>
          ) : null}
          {showRecent ? (
            <p aria-hidden="true" className="px-2.5 pb-1 pt-1.5 text-[11px] text-[color:var(--codespace-panel-text-quiet)]">Recent</p>
          ) : null}
          {items.map(renderItem)}
        </div>

        <div className="flex h-8 shrink-0 items-center gap-4 border-t border-[color:var(--codespace-panel-border)] bg-[color:var(--codespace-panel-surface)] px-3.5 text-[11px] text-[color:var(--codespace-panel-text-quiet)]">
          <span className="flex items-center gap-1.5"><Kbd>↑↓</Kbd>move</span>
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd>{commandMode ? "run" : "open"}</span>
          <span className="flex items-center gap-1.5"><Kbd>:42</Kbd>go to line</span>
          {commands.length > 0 ? <span className="flex items-center gap-1.5"><Kbd>&gt;</Kbd>commands</span> : null}
          <span className="flex items-center gap-1.5"><Kbd>esc</Kbd>close</span>
        </div>
      </div>
    </div>
  );
}
