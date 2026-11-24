"use client";
import { useState } from "react";
import { Archive, Pin, PinOff, RotateCcw } from "lucide-react";
import type { CodeCanvasMemoryItem } from "@/lib/tauri/codecanvas";
import {
  describeMemoryActor,
  describeMemoryScope,
  formatMemoryAge,
  isMemoryPinned,
} from "../../services/memory/codecanvas-memory-presentation";

/** Bodies longer than this get clamped to three lines with an explicit expand. */
const CLAMP_THRESHOLD = 180;

interface Props {
  item: CodeCanvasMemoryItem;
  now: number;
  onArchive: (itemId: string) => void;
  onRestore: (itemId: string) => void;
  onSetPinned: (itemId: string, pinned: boolean) => void;
  /** Currently filtered tag, so a row can show which of its tags is doing the filtering. */
  activeTag?: string | null;
  /** Filter the list by one of this row's tags. Absent = tags stay inert text. */
  onFilterTag?: (tag: string) => void;
}

/**
 * One memory row. Carries the provenance the store has always held but the panel used to drop: who
 * claimed it, how long ago, at what scope, and whether an agent actually reads it.
 */
export function CanvasMemoryItemRow({
  item,
  now,
  onArchive,
  onRestore,
  onSetPinned,
  activeTag,
  onFilterTag,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const pinned = isMemoryPinned(item);
  const archived = typeof item.archivedAt === "number";
  const text = item.summary || item.body;
  const clampable = !item.title ? text.length > CLAMP_THRESHOLD : text.length > CLAMP_THRESHOLD;
  const label = item.title || text.slice(0, 48);

  return (
    <li className="canvas-memory-item" data-archived={archived || undefined}>
      {/* No kind label and no reach badge here, deliberately.
          Both are pure functions of `item.kind`, and this row is only ever rendered inside a
          group whose header already states them — so a list of four rules printed "§ RULE" and
          "AGENTS READ THIS" four times under a heading that had just said both. Worse, the two
          places disagreed on wording ("agents read this" vs "read by agents"), so the repetition
          was not even consistent. The header carries kind, glyph, colour and reach once; the card
          is content. If this row ever renders outside a group, it needs the label back — that is
          what `kindOwnedByGroup` in the panel's list is asserting. */}
      {item.title ? <p className="canvas-memory-title">{item.title}</p> : null}
      <p
        className="canvas-memory-item-body"
        data-testid={`canvas-memory-body-${item.id}`}
        data-clamped={clampable && !expanded}
      >
        {text}
      </p>
      {clampable ? (
        <button
          type="button"
          className="canvas-memory-expand"
          aria-label={expanded ? `Collapse memory ${label}` : `Show full memory ${label}`}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "less" : "more"}
        </button>
      ) : null}

      <div className="canvas-memory-meta">
        <span className="canvas-memory-meta-who">{describeMemoryActor(item)}</span>
        <span className="canvas-memory-meta-sep" aria-hidden>·</span>
        <span>{formatMemoryAge(item.updatedAt, now)}</span>
        <span className="canvas-memory-meta-sep" aria-hidden>·</span>
        <span>{describeMemoryScope(item)}</span>
        {/* Tags are the one axis that cuts ACROSS kinds — `#verification` may sit on a rule, a
            decision and a blocker — and they were printed as dead text. Clicking one filters the
            list, so the provenance line becomes the fastest way to navigate rather than the last
            thing you read. Toggling: a second click on the same tag clears it, which is what
            everyone tries first. Without a handler they stay plain text, so the row is still
            usable anywhere it is rendered read-only. */}
        {item.tags.filter((tag) => tag !== "pinned").slice(0, 3).map((tag) =>
          onFilterTag ? (
            <button
              key={tag}
              type="button"
              className="canvas-memory-meta-tag"
              aria-pressed={activeTag === tag}
              aria-label={activeTag === tag ? `Clear tag filter ${tag}` : `Filter by tag ${tag}`}
              onClick={() => onFilterTag(tag)}
            >
              #{tag}
            </button>
          ) : (
            <span key={tag} className="canvas-memory-meta-tag">#{tag}</span>
          ),
        )}
        {pinned ? <span className="canvas-memory-meta-tag">◆ pinned</span> : null}
        {/* Archived state must read in text too: opacity alone is a colour-only status. */}
        {archived ? <span className="canvas-memory-meta-archived">archived</span> : null}

        <span className="canvas-memory-item-actions" data-always={archived || undefined}>
          <button
            type="button"
            className="canvas-memory-rowbtn"
            data-active={pinned || undefined}
            aria-label={pinned ? `Unpin memory ${label}` : `Pin memory ${label}`}
            onClick={() => onSetPinned(item.id, !pinned)}
          >
            {pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
          </button>
          {archived ? (
            <button
              type="button"
              className="canvas-memory-rowbtn"
              aria-label={`Restore memory ${label}`}
              onClick={() => onRestore(item.id)}
            >
              <RotateCcw size={12} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="canvas-memory-rowbtn"
              aria-label={`Archive memory ${label}`}
              onClick={() => onArchive(item.id)}
            >
              <Archive size={12} aria-hidden />
            </button>
          )}
        </span>
      </div>
    </li>
  );
}
