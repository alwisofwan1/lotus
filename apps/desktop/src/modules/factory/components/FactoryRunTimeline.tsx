"use client";

import { Check, ChevronDown, Minus, X } from "lucide-react";
import { useId, useState } from "react";
import type { FactoryEvent, FactoryEventTone } from "../services/factory-timeline";
import type { FactoryStageStatus } from "../services/factory-progress";
import { DitherPixels } from "./FactoryDither";

const SHOWN = 8;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The texture a mark draws: the stage strip's, so the rail and the strip read the same. */
const TEXTURE: Record<FactoryEventTone | "more", FactoryStageStatus> = {
  done: "done",
  ok: "done",
  bad: "failed",
  wait: "needs-you",
  live: "active",
  skipped: "todo",
  more: "todo",
};

/**
 * A step's mark on the rail: a 4×4 tile of the strip's texture (round 5) with the glyph on top, so
 * shape still says the state at 12px and colour is never the only signal.
 */
function EventMark({ tone }: { tone: FactoryEventTone | "more" }) {
  return (
    <span className="fa-event-mark" data-tone={tone} aria-hidden>
      <DitherPixels status={TEXTURE[tone]} pixel={3} />
      {tone === "done" || tone === "ok" ? <Check size={8} strokeWidth={3.5} /> : null}
      {tone === "bad" ? <X size={8} strokeWidth={3.5} /> : null}
      {tone === "skipped" ? <Minus size={8} strokeWidth={3} /> : null}
      {tone === "wait" ? <span className="fa-event-bang">!</span> : null}
    </span>
  );
}

/**
 * The run's events, newest last; the live one is last. The header says how the run went in one line
 * and folds the list away. Older events fold behind "+N earlier". The right column is only ever how
 * long a step took; the clock time an event happened at is its tooltip.
 */
export function FactoryRunTimeline({ events, summary }: { events: FactoryEvent[]; summary: { tone: FactoryEventTone; text: string } }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(true);
  const listId = useId();
  const hidden = all ? 0 : Math.max(0, events.length - SHOWN);
  const shown = events.slice(hidden);
  return (
    <section className="fa-timeline" aria-label="Timeline" data-open={open ? "true" : undefined}>
      <button type="button" className="fa-timeline-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <EventMark tone={summary.tone} />
        <span className="fa-timeline-summary">{summary.text}</span>
        <ChevronDown className="fa-timeline-chevron" size={15} strokeWidth={1.75} aria-hidden />
      </button>
      {open ? (
        <ol id={listId} className="fa-timeline-list">
          {hidden > 0 ? (
            <li className="fa-event-more">
              <EventMark tone="more" />
              <button type="button" className="fa-link" aria-expanded={false} onClick={() => setAll(true)}>
                +{hidden} earlier
              </button>
            </li>
          ) : null}
          {shown.map((event) => (
            <li key={event.key} className="fa-event" data-tone={event.tone} title={event.at !== null ? `At ${clock(event.at)}` : undefined}>
              <EventMark tone={event.tone} />
              <span className="fa-event-body">
                <span className="fa-event-label">{event.label}</span>
                {event.meta ? <span className="fa-event-meta">{event.meta}</span> : null}
              </span>
              {event.span !== null ? <span className="fa-event-span">{event.span}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
