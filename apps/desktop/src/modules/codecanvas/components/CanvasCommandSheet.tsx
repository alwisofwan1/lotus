"use client";
import { Fragment, useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { GROUP_LABEL, type SheetItem } from "../services/commands/command-sheet-items";
import { useCanvasOcclusionLock } from "../hooks/useCanvasOcclusionLock";
import { LaunchAccountTag } from "@/modules/chat/ui/ChatAccount";

/**
 * The ⌘K results sheet, rendered as a child of the NL command bar directly above its input row.
 *
 * Presentational and stateless: every decision — what is open, what is active, what a row does —
 * lives in `useCanvasCommandSheet`. What it is NOT is a dialog. The old centred palette was
 * `role="dialog" aria-modal` with a scrim, which was right for a surface that owned its own input
 * and trapped focus. This one is the listbox half of a combobox whose input is the bar's textarea,
 * so focus never leaves that textarea and there is no scrim to dismiss: the correct semantics are
 * `role="listbox"` beside an input that keeps `aria-activedescendant` pointed at the active row.
 */

/** Wrap the matched query runs in <mark> for type-ahead emphasis. Splits on the RAW title so
 *  React escapes each fragment — no dangerouslySetInnerHTML. */
export function highlightMatch(title: string, query: string): ReactNode {
  const parts = query.toLowerCase().trim().split(/\s+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.length) return title;
  const re = new RegExp(`(${parts.join("|")})`, "ig");
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(title)) !== null) {
    if (m.index > last) out.push(title.slice(last, m.index));
    out.push(<mark key={key++}>{m[0]}</mark>);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < title.length) out.push(title.slice(last));
  return out;
}

/** The DOM id of a row, so the bar's textarea can name the active one for assistive tech. */
export function sheetRowId(itemId: string): string {
  return `canvas-sheet-row-${itemId}`;
}

export const CANVAS_SHEET_LISTBOX_ID = "canvas-command-sheet-list";

interface Props {
  items: SheetItem[];
  activeIndex: number;
  query: string;
  /**
   * Browse mode (⌘K with nothing typed) shows the curated sections. Search mode is a flat ranked
   * list with no headings — the rows are ordered by relevance, so groups are no longer contiguous
   * and a heading would lie about what follows it. The category tag carries the classification.
   */
  grouped: boolean;
  onHover: (index: number) => void;
  onRun: (index: number) => void;
}

export function CanvasCommandSheet({ items, activeIndex, query, grouped, onHover, onRun }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // A native Canvas Browser Node WebView paints above the whole DOM, so it clipped the palette this
  // replaces and would clip these rows too. The component only exists while the sheet is open, so
  // its mere presence IS the lock condition.
  useCanvasOcclusionLock(true, "canvas-command-sheet");

  // Keep the active row in view as the selection moves (keyboard + re-filtering).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // jsdom has no scrollIntoView; guard so tests (and any non-DOM host) don't throw.
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items.length]);

  return (
    <div className="canvas-sheet" data-empty={items.length ? undefined : "true"} data-mode={grouped ? "browse" : "search"}>
      <div
        ref={listRef}
        id={CANVAS_SHEET_LISTBOX_ID}
        className="canvas-sheet-list"
        role="listbox"
        aria-label="Canvas commands"
      >
        {items.length ? (
          items.map((item, index) => {
            const prev = items[index - 1];
            const newGroup = !prev || prev.group !== item.group;
            // The send group gets a rule instead of a heading: it is one row, and it is the row
            // that leaves the catalog behind.
            const showHeader = grouped && newGroup && item.group !== "send";
            const Icon = item.Icon;
            const active = index === activeIndex;
            return (
              <Fragment key={item.id}>
                {showHeader && (
                  <div className="canvas-sheet-section" aria-hidden>
                    {GROUP_LABEL[item.group]}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  id={sheetRowId(item.id)}
                  aria-selected={active}
                  className="canvas-sheet-row"
                  data-active={active ? "true" : undefined}
                  data-tone={item.tone}
                  data-group={item.group}
                  // Pointer down, not click: the textarea keeps focus, and mousedown fires before
                  // the blur that a click would otherwise race.
                  onPointerDown={(e) => { e.preventDefault(); onRun(index); }}
                  onMouseEnter={() => onHover(index)}
                  tabIndex={-1}
                >
                  <span className="canvas-sheet-row-icon" style={{ "--row-hue": item.hue } as CSSProperties}>
                    <Icon size={12} strokeWidth={1.75} aria-hidden />
                  </span>
                  <span className="canvas-sheet-row-body">
                    <span className="canvas-sheet-row-title">{highlightMatch(item.title, query)}</span>
                    {/* Rows whose detail would only restate the title carry an empty one — see
                        the switch-project rows in the catalog. No empty element, no stray gap. */}
                    {item.detail ? <span className="canvas-sheet-row-detail">{item.detail}</span> : null}
                  </span>
                  {active && item.action.kind === "custom" && item.action.alt ? (
                    <span className="canvas-sheet-row-alt" aria-hidden>⌘↵ {item.action.alt.hint}</span>
                  ) : null}
                  {item.cycle ? <LaunchAccountTag account={item.account ?? null} onCycle={item.cycle} /> : null}
                  <span className="canvas-sheet-row-tag" aria-hidden>{item.tag}</span>
                </button>
              </Fragment>
            );
          })
        ) : (
          <div className="canvas-sheet-empty" role="status">
            No command matches that search.
          </div>
        )}
      </div>
    </div>
  );
}
