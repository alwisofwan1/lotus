"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Factory, Folder, LayoutGrid, ListChecks, Search, Zap } from "lucide-react";
import { highlight } from "@/modules/workspace-shell/components/CommandSheet";
import { KindIcon } from "@/modules/workspace-shell/components/kind-glyph";
import {
  buildJumpItems,
  emptyJumpList,
  jumpAge,
  searchJumpList,
  type JumpItem,
  type JumpSources,
  type JumpStatus,
  type JumpTarget,
} from "@/modules/workspace-shell/services/jump-items";
import "@/styles/jump-palette.css";

const STATUS_LABEL: Record<JumpStatus, string> = { waiting: "Waiting", working: "Working", done: "Done" };

function JumpIcon({ icon }: { icon: JumpItem["icon"] }) {
  if (icon === "workspace") return <Folder size={13} strokeWidth={1.75} />;
  if (icon === "mode") return <LayoutGrid size={13} strokeWidth={1.75} />;
  if (icon === "factory") return <Factory size={13} strokeWidth={1.75} />;
  if (icon === "automation") return <Zap size={13} strokeWidth={1.75} />;
  if (icon === "task") return <ListChecks size={13} strokeWidth={1.75} />;
  return <KindIcon kind={icon} size={13} />;
}

/**
 * The Jump palette (GLOSSARY "Jump palette"): ⌘J from any mode, to any workspace, pane, Chat thread or mode.
 *
 * Mounted only while open, so the sources are read once and the list holds still under the user's
 * eye while agents change state behind it.
 */
export function JumpPalette({
  getSources,
  onJump,
  onMarkSeen,
  onClose,
}: {
  getSources: () => JumpSources;
  onJump: (target: JumpTarget) => void;
  /** A Done row's "Mark seen": it leaves Needs you without being opened. */
  onMarkSeen?: (target: JumpTarget) => void;
  onClose: () => void;
}) {
  const [items] = useState(() => buildJumpItems(getSources()));
  const [frozen] = useState(() => emptyJumpList(items));
  // Marked seen while open: gone from the list now, since the list does not re-read its sources.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const empty = seen.size ? frozen.filter((item) => !seen.has(item.id)) : frozen;
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const rows = query.trim() ? searchJumpList(items, query) : empty;
  const searching = Boolean(query.trim());
  const waitingCount = searching ? 0 : empty.filter((item) => item.status === "waiting").length;
  const doneCount = searching ? 0 : empty.filter((item) => item.status === "done").length;
  // The divider after Needs you, on the empty list only.
  const leadCount = waitingCount + doneCount;
  const current = Math.min(active, Math.max(rows.length - 1, 0));

  // Give focus back to where it was, unless a jump already moved it.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => {
      if (document.activeElement === document.body || document.activeElement === null) before?.focus?.();
    };
  }, []);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [current, query]);

  const jump = (item: JumpItem | undefined) => {
    if (!item) return;
    onClose();
    onJump(item.target);
  };

  const markSeen = (item: JumpItem | undefined) => {
    if (!item || item.status !== "done" || !onMarkSeen) return;
    onMarkSeen(item.target);
    setSeen((was) => new Set(was).add(item.id));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + rows.length) % rows.length);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      jump(rows[current]);
    } else if (event.key === "Backspace" && !query && rows[current]?.status === "done") {
      event.preventDefault();
      markSeen(rows[current]);
    }
  };

  return createPortal(
    <div className="jp-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="jp" role="dialog" aria-modal="true" aria-label="Jump to" onKeyDown={onKeyDown}>
        <div className="jp-input">
          <Search size={15} strokeWidth={1.75} aria-hidden />
          <input
            autoFocus
            value={query}
            placeholder="Jump to a workspace, pane, chat or mode"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows[current] ? `${listId}-${current}` : undefined}
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="jp-list" id={listId} role="listbox" ref={listRef}>
          {rows.length === 0 ? (
            <p className="jp-empty">{searching ? `Nothing matches “${query.trim()}”` : "Nothing needs you. Type to search."}</p>
          ) : (
            rows.map((item, index) => (
              <div key={item.id}>
                {index === 0 && waitingCount > 0 ? <GroupTitle label="Waiting" count={waitingCount} /> : null}
                {index === waitingCount && doneCount > 0 ? <GroupTitle label="Done, not seen" count={doneCount} /> : null}
                {index === leadCount && index > 0 ? <div className="jp-sep" role="separator" /> : null}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === current}
                  className="jp-row"
                  onMouseMove={() => index !== current && setActive(index)}
                  onClick={() => jump(item)}
                >
                  <span className="jp-icon" aria-hidden>
                    <JumpIcon icon={item.icon} />
                  </span>
                  <span className="jp-body">
                    <span className="jp-text">
                      <span className="jp-title">{highlight(item.title, query)}</span>
                      <span className="jp-loc">
                        {item.location}
                        {item.host ? <span className="jp-host">{item.host}</span> : null}
                      </span>
                    </span>
                    {item.detail && item.status !== "working" ? <span className="jp-detail">{item.detail}</span> : null}
                  </span>
                  {item.status === "done" && onMarkSeen ? (
                    <button
                      type="button"
                      className="jp-seen"
                      title="Mark seen (⌫)"
                      onClick={(event) => {
                        event.stopPropagation();
                        markSeen(item);
                      }}
                    >
                      Mark seen
                    </button>
                  ) : null}
                  {item.status ? (
                    <span className="jp-status" data-status={item.status}>
                      <i aria-hidden />
                      {STATUS_LABEL[item.status]}
                    </span>
                  ) : null}
                  <span className="jp-age">{jumpAge(item.at, now)}</span>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="jp-foot">
          <span><kbd>↑↓</kbd>move</span>
          <span><kbd>↵</kbd>jump</span>
          {doneCount > 0 && onMarkSeen ? <span><kbd>⌫</kbd>mark seen</span> : null}
          <span className="jp-foot-end"><kbd>⌘⇧J</kbd>oldest waiting</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function GroupTitle({ label, count }: { label: string; count: number }) {
  return (
    <div className="jp-group" role="presentation">
      {label} <span>{count}</span>
    </div>
  );
}
