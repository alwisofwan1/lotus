"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { CornerDownLeft, SearchX } from "lucide-react";
import { ActivityBadge } from "@/modules/workspace-shell/components/ActivityBadge";
import { KindIcon } from "@/modules/workspace-shell/components/kind-glyph";
import { LaunchAccountTag } from "@/modules/chat/ui/ChatAccount";
import type { CommandItem, RankedCommands } from "@/modules/workspace-shell/services/command-items";

export const COMMAND_SHEET_LISTBOX_ID = "ws-command-sheet-list";

/** The DOM id of a row, so the composer's textarea can name the active one for assistive tech. */
export function commandRowId(itemId: string): string {
  return `ws-command-row-${itemId}`;
}

/**
 * The ⌘K results, drawn directly above the composer that owns the input.
 *
 * It is **not a dialog**. A centred palette with a scrim would be right for a surface that owns its
 * own input and traps focus; this one is the listbox half of a combobox whose input is the
 * composer's textarea. Focus never leaves that textarea, so there is nothing to trap and no scrim
 * to dismiss — and it is why a second input box was never added: the shell already has the place
 * you type.
 *
 * Presentational and stateless. What is open, which row is active, and what a row does all live in
 * the container; this file decides only how a row looks.
 */
export function CommandSheet({
  ranked,
  activeIndex,
  query,
  onHover,
  onRun,
}: {
  ranked: RankedCommands;
  activeIndex: number;
  query: string;
  onHover: (index: number) => void;
  onRun: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  /*
    One highlight that slides to the active row, instead of each row lighting itself: the
    selection travels, so ↑↓ reads as motion rather than as rows blinking. Measured from the row
    itself, because sections make the rows unevenly spaced. Written to the element, not to state:
    a measurement that only moves a box needs no second render.
  */
  const cursorRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    cursor.hidden = !active;
    if (!active) return;
    cursor.style.transform = `translateY(${active.offsetTop}px)`;
    cursor.style.height = `${active.offsetHeight}px`;
  }, [activeIndex, ranked]);

  // Keyboard navigation has to be able to reach a row that is scrolled out of sight — the arrow
  // keys move the active index, and nothing else would bring the list along.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // Optional call, not a cast: jsdom has no `scrollIntoView`, and a test environment missing a
    // scroll API is not a reason for the sheet to throw during a render.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  if (ranked.items.length === 0) {
    return (
      <div className="ws-sheet" role="presentation">
        <div className="ws-sheet-empty">
          <SearchX size={16} strokeWidth={1.75} aria-hidden />
          <p>
            No commands match “{query}”.
            <span>
              Try <kbd>new agent</kbd> or a pane name.
            </span>
          </p>
        </div>
      </div>
    );
  }

  const sectionAt = new Map(ranked.sections.map((section) => [section.index, section.label]));
  // A section runs until the next one starts, or to the end of the list.
  const sectionCount = new Map(
    ranked.sections.map((section, i) => [
      section.index,
      (ranked.sections[i + 1]?.index ?? ranked.items.length) - section.index,
    ]),
  );

  return (
    <div className="ws-sheet" role="presentation">
      <div className="ws-sheet-list" id={COMMAND_SHEET_LISTBOX_ID} role="listbox" ref={listRef}>
        <span className="ws-sheet-cursor" aria-hidden ref={cursorRef} hidden />
        {ranked.items.map((item, index) => (
          <div key={item.id}>
            {sectionAt.has(index) ? (
              <p className="ws-sheet-section">
                {sectionAt.get(index)}
                <span className="ws-sheet-section-count">{sectionCount.get(index)}</span>
              </p>
            ) : null}
            <div
              id={commandRowId(item.id)}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={item.disabled || undefined}
              data-active={index === activeIndex ? "true" : undefined}
              data-disabled={item.disabled ? "true" : undefined}
              className="ws-sheet-row"
              onMouseMove={() => onHover(index)}
              onClick={() => onRun(index)}
            >
              <span className="ws-sheet-icon" data-kind={item.kind}>
                <KindIcon kind={item.kind} size={13} />
              </span>
              <span className="ws-sheet-text">
                {item.activity ? <ActivityBadge activity={item.activity} compact /> : null}
                <span className="ws-sheet-title">{highlight(item.title, query)}</span>
                <span className="ws-sheet-detail">{item.detail}</span>
              </span>
              {item.cycle ? <LaunchAccountTag account={item.account ?? null} onCycle={item.cycle} /> : null}
              {/* The tag is what Enter will do; the section above already names the kind, so the
                  row shows the key and keeps the words for the tooltip and a screen reader. */}
              <kbd className="ws-sheet-enter" title={item.tag}>
                <CornerDownLeft size={11} strokeWidth={2} aria-hidden />
                <span className="sr-only">{item.tag}</span>
              </kbd>
            </div>
          </div>
        ))}
      </div>
      <div className="ws-sheet-hint">
        <span><kbd>↑↓</kbd>select</span>
        {ranked.items[activeIndex]?.cycle ? <span><kbd>⇥</kbd>account</span> : null}
        <span><kbd>⏎</kbd>run</span>
        <span><kbd>esc</kbd>close</span>
      </div>
    </div>
  );
}

/**
 * Emphasise what was typed, by splitting the RAW title so React escapes each fragment — the
 * alternative is `dangerouslySetInnerHTML` over a string that includes a workspace name.
 */
export function highlight(title: string, query: string): ReactNode {
  const words = query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return title;

  const pattern = new RegExp(`(${words.join("|")})`, "ig");
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(title)) !== null) {
    if (match.index > last) out.push(title.slice(last, match.index));
    out.push(<mark key={key++}>{match[0]}</mark>);
    last = match.index + match[0].length;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  if (last < title.length) out.push(title.slice(last));
  return out;
}

export type { CommandItem };
