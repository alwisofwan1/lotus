"use client";

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";

import { MAX_TICKS, MIN_PROMPTS, activeTick, buildPromptIndex, railFit, railTicks } from "../../domain/history";
import type { TimelineRow } from "../../domain/timeline";
import { TimelineRowView } from "./TimelineRowView";
import { DitherTile } from "../Dither";
import { SelectionToChat } from "../SelectionToChat";
import { TurnActionsContext } from "../ChatTurnActions";

/** Within this distance of the end counts as "at the bottom", so new text keeps it in view. */
const BOTTOM_SLACK_PX = 48;
/** A scroll this soon after the user's own input is theirs; macOS keeps sending wheel events
 *  through momentum, so a flick stays "theirs" until it stops. */
const USER_SCROLL_MS = 250;

interface ChatTimelineProps {
  rows: TimelineRow[];
  /** What the running turn is doing, shown under the last row; null when idle or waiting on the user. */
  working: string | null;
}

/**
 * The thread's rows, virtualized: only the rows near the viewport are mounted, so a long thread
 * stays fast. Mount one per thread (`key={threadId}`), so scroll and open rows start fresh.
 *
 * Scroll anchoring is done here in JS, not with CSS `overflow-anchor`, which WKWebView does not
 * apply reliably: at the bottom, the view follows new content; scrolled up, a row above the
 * viewport that changes height moves the scroll position by the same amount, so the text being
 * read stays still.
 */
export function ChatTimeline({ rows, working }: ChatTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const turnActions = useContext(TurnActionsContext);
  const canvasRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // When the user last wheeled, touched, pressed a key or a pointer in the timeline.
  const intentAt = useRef(Number.NEGATIVE_INFINITY);
  const markIntent = useCallback(() => {
    intentAt.current = performance.now();
  }, []);
  // The user's own open/closed choice per work row. A row without one follows its state (open while
  // live, folded when done), so a choice made while live is not inverted when the run ends.
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  const onToggle = useCallback((rowId: string, open: boolean) => {
    setExpanded((previous) => new Map(previous).set(rowId, open));
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey: (index) => rows[index].id,
  });
  // Compensate only for a row wholly above the viewport. The default also shifts for a row that
  // starts above it, which moves a long streaming reply while it is being read.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0);

  // How many marks fit the rail; set from the timeline's height by the ResizeObserver below.
  const [railMax, setRailMax] = useState(MAX_TICKS);
  const entries = useMemo(() => buildPromptIndex(rows), [rows]);
  const ticks = useMemo(() => railTicks(entries, railMax), [entries, railMax]);
  const topRow = virtualizer.range?.startIndex ?? 0;
  const current = activeTick(ticks, topRow);
  const here = entries.findLastIndex((entry) => entry.rowIndex <= topRow);
  // The prompt just jumped to, marked for a moment so the eye finds where it landed.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(timer);
  }, [flash]);
  const jumpToPrompt = useCallback(
    (rowIndex: number) => {
      // Leaving the end on purpose: without this the follow-the-end pin pulls it straight back.
      atBottom.current = false;
      // Instant, like jumpToLatest: a smooth scroll over unmeasured rows lands short.
      virtualizer.scrollToIndex(rowIndex, { align: "start" });
      setFlash(rows[rowIndex]?.id ?? null);
    },
    [virtualizer, rows],
  );

  // History panel: hovering the rail opens the full prompt list (mockups/chat-history-rail-v2.html).
  const [open, setOpen] = useState(false);
  // The prompt under the pointer or keyboard while open; -1 falls back to where the reader is.
  const [peek, setPeek] = useState(-1);
  const active = peek >= 0 ? peek : Math.max(here, 0);
  const listRef = useRef<HTMLDivElement>(null);
  const intent = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Open after a beat so a pointer passing by does not flash it; close after a grace so a diagonal
  // move from the dashes into the panel survives.
  const openAfter = useCallback((next: boolean, ms: number) => {
    clearTimeout(intent.current);
    intent.current = setTimeout(() => {
      setOpen(next);
      if (!next) setPeek(-1);
    }, ms);
  }, []);
  useEffect(() => () => clearTimeout(intent.current), []);
  const centre = useCallback((index: number) => {
    const list = listRef.current;
    const item = list?.children[index] as HTMLElement | undefined;
    if (list && item) list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
  }, []);
  // Opening lands the list on the prompt being read.
  useLayoutEffect(() => {
    if (open) centre(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open; later moves centre themselves
  }, [open, centre]);
  const onRailKey = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        clearTimeout(intent.current);
        setOpen(false);
        setPeek(-1);
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      const to = { ArrowUp: active - 1, ArrowDown: active + 1, Home: 0, End: entries.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      const index = Math.max(0, Math.min(entries.length - 1, to));
      (listRef.current?.children[index] as HTMLElement | undefined)?.focus();
    },
    [active, entries.length],
  );
  // Sweeping the dashes scrubs the list.
  const onTicksMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const at = Math.floor(((event.clientY - box.top) / box.height) * ticks.length);
      const tick = ticks[Math.max(0, Math.min(ticks.length - 1, at))];
      if (!tick || tick.from - 1 === peek) return;
      setPeek(tick.from - 1);
      centre(tick.from - 1);
    },
    [ticks, peek, centre],
  );
  const peekTick = peek < 0 ? -1 : ticks.findIndex((tick) => peek + 1 >= tick.from && peek + 1 <= tick.to);

  const totalSize = virtualizer.getTotalSize();
  // A live work card, or the caret at the end of the reply, already shows what the turn is doing.
  const last = rows.at(-1);
  const live = (last?.kind === "work" && last.status === "running") || last?.kind === "assistant";
  const status = live ? null : working;
  // Scrolled more than a screen above the end: offer the way back.
  const [away, setAway] = useState(false);
  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    atBottom.current = true;
    // Instant, not smooth: rows measured on the way would leave a smooth scroll short of the end.
    if (element) element.scrollTop = element.scrollHeight;
    setAway(false);
  }, []);
  // A message the user just sent goes back to the end, wherever they were reading.
  const lastSent = rows.findLast((row) => row.kind === "user")?.id;
  const seenSent = useRef(lastSent);
  useLayoutEffect(() => {
    if (lastSent === seenSent.current) return;
    seenSent.current = lastSent;
    jumpToLatest();
  }, [lastSent, jumpToLatest]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [totalSize, rows.length, status]);

  // Rows measured after the first paint, and the composer below growing or shrinking (its tray,
  // the changes bar), change the size without changing anything above. A ResizeObserver runs after
  // layout and before paint, so pinning there lands at the end without a visible jump.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const canvas = canvasRef.current;
    if (!element || !canvas) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
      setRailMax(railFit(element.clientHeight));
    });
    observer.observe(element);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="chat-timeline-wrap">
      <div
        ref={scrollRef}
        className="chat-timeline"
        onWheel={markIntent}
        onTouchMove={markIntent}
        onKeyDown={markIntent}
        onPointerDown={markIntent}
        onScroll={(event) => {
          const el = event.currentTarget;
          let below = el.scrollHeight - el.scrollTop - el.clientHeight;
          // Only the user leaves the bottom. A scroll event also follows our own pin and the
          // virtualizer's size corrections, and by then rows measured since can put the end more
          // than the slack away; reading that as "scrolled up" stopped the follow halfway down.
          if (performance.now() - intentAt.current < USER_SCROLL_MS) atBottom.current = below < BOTTOM_SLACK_PX;
          else if (atBottom.current && below > 1) {
            // Following, yet moved off the end without the user: put it back. Typing in the
            // composer re-renders the rows, and a re-measure then scrolled up ~20px with nothing
            // resized, so no pin ran and the bottom fade covered the last line.
            el.scrollTop = el.scrollHeight;
            below = el.scrollHeight - el.scrollTop - el.clientHeight;
          } else if (below < BOTTOM_SLACK_PX) atBottom.current = true;
          // Straight to the DOM: soft edges must not re-render the timeline on every scroll frame.
          el.toggleAttribute("data-fade-top", el.scrollTop > 2);
          el.toggleAttribute("data-fade-bottom", below > 2);
          const isAway = !atBottom.current && below > el.clientHeight;
          if (isAway !== away) setAway(isAway);
        }}
      >
        <div ref={canvasRef} className="chat-timeline-canvas" style={{ height: totalSize }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="chat-timeline-item"
              data-flash={rows[item.index].id === flash || undefined}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <TimelineRowView
                row={rows[item.index]}
                expanded={expanded.get(rows[item.index].id)}
                onToggle={onToggle}
                pending={working !== null && item.index === rows.length - 1}
              />
            </div>
          ))}
        </div>
        {status !== null && (
          <div className="chat-row chat-working-row" role="status">
            <span className="chat-working-label">{status}</span>
            <span className="chat-working" aria-hidden />
          </div>
        )}
      </div>
      {ticks.length >= MIN_PROMPTS && (
        <nav
          className="chat-history"
          aria-label="Prompts in this chat"
          data-open={open || undefined}
          onPointerEnter={() => openAfter(true, open ? 0 : 90)}
          onPointerLeave={() => openAfter(false, 220)}
          onFocus={() => {
            clearTimeout(intent.current);
            setOpen(true);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) openAfter(false, 0);
          }}
          onKeyDown={onRailKey}
        >
          <div className="chat-history-ticks" aria-hidden onPointerMove={open ? onTicksMove : undefined} onClick={() => entries[active] && jumpToPrompt(entries[active].rowIndex)}>
            {ticks.map((tick, i) => (
              <span key={tick.first.rowIndex} className="chat-history-tick" data-current={i === current || undefined} data-peek={(open && i === peekTick) || undefined} />
            ))}
          </div>
          <div className="chat-history-panel">
            <div className="chat-history-head">
              <span>Prompts</span>
              <span>{entries.length}</span>
            </div>
            <div ref={listRef} className="chat-history-list">
              {entries.map((entry, i) => (
                <button
                  key={entry.rowIndex}
                  type="button"
                  className="chat-history-item"
                  aria-current={i === here ? "location" : undefined}
                  data-active={(open && i === active) || undefined}
                  tabIndex={i === active ? 0 : -1}
                  aria-label={`Prompt ${i + 1}: ${entry.prompt}`}
                  onPointerEnter={() => setPeek(i)}
                  onFocus={() => setPeek(i)}
                  onClick={() => jumpToPrompt(entry.rowIndex)}
                >
                  <span className="chat-history-n" aria-hidden>{i + 1}</span>
                  <span className="chat-history-prompt">{entry.prompt}</span>
                  {entry.reply && <span className="chat-history-reply">{entry.reply}</span>}
                </button>
              ))}
            </div>
          </div>
        </nav>
      )}
      {turnActions && <SelectionToChat scope={scrollRef} onAdd={turnActions.quote} />}
      {/* Outside the scroller: its fade would dim the button, and a press inside reads as the user scrolling. */}
      {away && (
        <button type="button" className="chat-jump" data-live={working !== null || undefined} aria-label="Jump to latest" title="Jump to latest" onClick={jumpToLatest}>
          {working !== null && (
            <>
              <DitherTile lit={16} data-live="" />
              <span className="chat-jump-label">{working}</span>
            </>
          )}
          <ArrowDown size={14} strokeWidth={1.8} aria-hidden />
        </button>
      )}
    </div>
  );
}
