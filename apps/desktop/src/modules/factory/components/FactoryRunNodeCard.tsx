"use client";

import type { FactoryRef } from "../services/factory-run";
import type { FactoryRunRow } from "../services/factory-run-list";
import { factoryNodeView } from "../services/factory-node";
import { FactoryStageBar } from "./FactoryStageBar";
import "@/styles/factory.css";

/**
 * One issue's Factory Run as a card a host can place: a canvas node (#146). Title, the run's
 * sentence, the four stages and time · cost. Only a run that needs you has a button, named by its
 * next step (Answer, Approve, Try again); it opens the run where that step is taken. Anything else
 * opens with a double-click, which the host also gets as `onOpen`.
 */
export function FactoryRunNodeCard({
  row,
  saved,
  now,
  loading,
  onOpen,
}: {
  row: FactoryRunRow | null;
  /** What the host kept about the issue, shown when the run cannot be read. */
  saved: { issue: FactoryRef; title: string };
  now: number;
  loading: boolean;
  onOpen: () => void;
}) {
  const view = factoryNodeView(row, saved, now, loading);
  return (
    <div
      className="fa-node"
      data-group={view.group ?? undefined}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      <p className="fa-node-title">
        <span className="fa-glyph" data-group={view.group ?? "stopped"} aria-hidden />
        <span className="fa-node-name">{view.title}</span>
      </p>
      <p className="fa-node-sentence">{view.sentence}</p>
      {row ? <FactoryStageBar progress={row.progress} state={row.state} pixel={4} /> : null}
      {view.meta ? <p className="fa-node-meta fa-time">{view.meta}</p> : null}
      {view.needsYou ? (
        // `nodrag`: on a canvas the press is a click, not the start of a move.
        <button type="button" className="rs-button fa-node-action nodrag" onClick={onOpen}>
          {view.next}
        </button>
      ) : null}
    </div>
  );
}
