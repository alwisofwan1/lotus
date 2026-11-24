"use client";

import { memo, useCallback, useSyncExternalStore } from "react";
import { ageClock } from "@/modules/workspace-shell/services/age-clock";
import {
  formatPaneActivityAge,
  paneActivityAnimates,
  paneActivityLabel,
  paneActivityShowsAge,
  paneActivityTone,
} from "@/modules/workspace-shell/services/pane-activity";
import type { PaneActivity } from "@/modules/workspace-shell/types";

/**
 * The current time, but only for a badge that prints an age.
 *
 * Subscribing is what starts the shared clock, so a workspace of resting panes runs no timer at
 * all. A badge that shows no age subscribes to nothing and never re-renders for one.
 *
 * `null` on the server, where there is no clock worth reading and no ticking to hydrate from: the
 * first paint shows the label alone and the age appears on the client's first tick-aware render.
 */
export function useAgeNow(enabled: boolean): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => (enabled ? ageClock.subscribe(onChange) : () => {}),
    [enabled],
  );
  const getSnapshot = useCallback(() => (enabled ? ageClock.now() : null), [enabled]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export interface ActivityBadgeProps {
  activity: PaneActivity;
  /** When the pane entered this state, for the age. */
  since?: number;
  /**
   * Dot only, no words.
   *
   * The rail gives a row one line and the pane header has a title to protect, so the badge has to
   * be able to say it in eight pixels. The words survive as the accessible name either way — a
   * colour alone is not a label.
   */
  compact?: boolean;
  /**
   * Show only the age ("4m"), no label. The rail draws "working" as a ring on the mark, so the
   * word would say it twice. The full text stays the accessible name.
   */
  ageOnly?: boolean;
  className?: string;
}

function ActivityBadgeImpl({ activity, since, compact = false, ageOnly = false, className }: ActivityBadgeProps) {
  const showsAge = paneActivityShowsAge(activity) && typeof since === "number";
  // Ticks only while an age is on screen.
  const now = useAgeNow(showsAge);

  const label = paneActivityLabel(activity);
  const age = showsAge && now !== null ? formatPaneActivityAge(now - since!) : null;
  const text = age ? `${label} · ${age}` : label;

  return (
    <span
      className={className ? `ws-activity ${className}` : "ws-activity"}
      data-activity={activity}
      data-tone={paneActivityTone(activity)}
      /* Motion is reserved for work in progress. `needs-you` must never animate: a spinner over
         "answer me" reads as progress, which is the lie `plans/honest-agent-status/` removed. */
      data-animate={paneActivityAnimates(activity) ? "true" : undefined}
      data-compact={compact ? "true" : undefined}
      title={text}
    >
      <span className="ws-activity-dot" aria-hidden />
      {compact ? (
        // The words still reach a screen reader; only the pixels are spared.
        <span className="sr-only">{text}</span>
      ) : ageOnly ? (
        <>
          {age ? <span className="ws-activity-label" aria-hidden>{age}</span> : null}
          <span className="sr-only">{text}</span>
        </>
      ) : (
        <span className="ws-activity-label">{text}</span>
      )}
    </span>
  );
}

/**
 * Memoised because it is drawn once per pane and re-rendered by anything that touches the grid.
 * Its own props change only when the pane's state does.
 */
export const ActivityBadge = memo(ActivityBadgeImpl);
