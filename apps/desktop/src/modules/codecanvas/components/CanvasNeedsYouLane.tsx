"use client";

/**
 * The triage lane: the agents waiting for a human, pinned above the inbox
 * (`plans/honest-agent-status/` Slice 4).
 *
 * **Why it is its own strip rather than a bucket inside the Agent Inbox.** The inbox is
 * height-clamped (`clamp(7rem, 32vh, 18rem)`) and scrolls, so a "pinned" group inside it scrolls
 * out of view on a busy board — the one thing this lane must never do. It therefore sits outside
 * every scroll container in the sidebar, and the plan's original "first bucket" spec was changed
 * for exactly that reason.
 *
 * **Why it stays mounted when empty.** A lane that appears from nowhere shifts every row beneath it
 * at the moment the operator is reaching for one. Empty, it collapses to a single dimmed header —
 * which also teaches the affordance before it is needed, and makes the count going 0 → 1 the signal.
 *
 * Each row carries the wait AND the headline, not just the name: "Atlas needs you" alone still sends
 * the operator to the terminal to find out what for.
 */

import { Bell } from "lucide-react";
import { formatWaiting, NEEDS_YOU_SOURCE_LABEL, type NeedsYouEntry } from "../services/needs-you-queue";

interface Props {
  /** Ordered by {@link needsYouQueue} — longest wait first. Rendered as given. */
  entries: readonly NeedsYouEntry[];
  onFocusNode: (nodeId: string) => void;
  /** The effective jump chord, e.g. `⌘J`. Shown only while there is something to jump to. */
  jumpHint?: string;
}

export function CanvasNeedsYouLane({ entries, onFocusNode, jumpHint }: Props) {
  const empty = entries.length === 0;
  // "agents" while only agents wait, as before S5; a mixed queue counts items.
  const allAgents = entries.every((entry) => (entry.source ?? "agent") === "agent");
  const label = empty
    ? "Needs you — nothing waiting"
    : allAgents
      ? `Needs you — ${entries.length} agent${entries.length === 1 ? "" : "s"} waiting`
      : `Needs you — ${entries.length} waiting`;

  return (
    <section
      className="canvas-needs-you"
      data-testid="needs-you-lane"
      data-empty={empty ? "true" : "false"}
      aria-label={label}
    >
      <div className="canvas-needs-you-header">
        <Bell size={11} aria-hidden />
        <span className="canvas-needs-you-title">Needs you</span>
        <span className="canvas-needs-you-count" data-testid="needs-you-count">
          {entries.length}
        </span>
        {/* Suppressed while empty: advertising a jump with nowhere to land is noise, and the chord
            is a no-op in that state anyway (see the Slice 5 selector). */}
        {!empty && jumpHint && (
          <span className="canvas-needs-you-chord" data-testid="needs-you-jump-hint">
            {jumpHint}
          </span>
        )}
      </div>

      {!empty && (
        <div className="canvas-needs-you-rows">
          {entries.map((entry) => {
            const waited = formatWaiting(entry.waitingMs);
            const source = entry.source ?? "agent";
            // An agent is focused on the canvas; a Dock app's ask opens in the Dock (S5).
            const opens = source !== "agent" && entry.onOpen;
            const verb = opens ? `Open ${entry.name} in ${NEEDS_YOU_SOURCE_LABEL[source]}` : `Focus ${entry.name}`;
            return (
              <button
                key={entry.id}
                type="button"
                className="canvas-needs-you-row"
                data-source={source}
                aria-label={`${verb}${waited ? `, waiting ${waited}` : ""}`}
                onClick={() => (opens ? entry.onOpen?.() : onFocusNode(entry.id))}
              >
                <span className="canvas-needs-you-dot" aria-hidden />
                <span className="canvas-needs-you-body">
                  <span className="canvas-needs-you-name" data-testid="needs-you-name">
                    {source !== "agent" ? (
                      <span className="canvas-needs-you-source" data-testid="needs-you-source">
                        {NEEDS_YOU_SOURCE_LABEL[source]}
                      </span>
                    ) : null}
                    {entry.name}
                  </span>
                  {/* Deliberately outside the accessible label, which already reads
                      "Focus Atlas, waiting 8s" — appending this would turn the label into a
                      sentence and bury the action. */}
                  {entry.headline && (
                    <span className="canvas-needs-you-headline" data-testid="needs-you-headline">
                      {entry.headline}
                    </span>
                  )}
                </span>
                {waited && (
                  <span className="canvas-needs-you-age" data-testid="needs-you-age">
                    {waited}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
