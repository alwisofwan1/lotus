/**
 * What the chrome's status pill says about Code mode.
 *
 * It used to be `livePaneCount` alone, which counts terminals holding a live PTY. A workspace of
 * two conversations and no terminal therefore reported "0 sesi hidup" — literally true, and a lie
 * as a sentence, because two agents were answering at that moment (seen in the native window,
 * 2026-09-20).
 *
 * A conversation is not a PTY session, so it is counted as itself. An idle terminal is named
 * idle rather than folded into a "live" count it is not part of.
 */

/** English counts read wrong without it: "1 terminals live" is a sentence nobody writes. */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export interface CodeModePaneCounts {
  terminals: number;
  liveTerminals: number;
  chatPanes: number;
  /** Panes doing something right now. */
  working?: number;
  /** Panes blocked on a human — the only count that is a request rather than a fact. */
  needsYou?: number;
  /** Panes whose finished turn nobody has opened yet (`pane-unread.ts`). */
  unread?: number;
}

/**
 * What is happening beats what exists.
 *
 * An inventory ("3 terminal hidup · 2 thread") answers a question nobody asks twice; it is what
 * the pill falls back to when there is nothing going on. The moment a pane is working, or worse
 * is waiting on a human, THAT is the sentence — a title bar has room for one, and the one worth
 * having is the one that changes what someone does next.
 */
export function codeModeStatusLabel({
  terminals,
  liveTerminals,
  chatPanes,
  working = 0,
  needsYou = 0,
  unread = 0,
}: CodeModePaneCounts): string {
  // In that order: an ask outranks a result waiting to be read, which outranks progress. All that
  // apply are said — hiding the progress would make a busy workspace look stalled behind one prompt.
  const happening = [
    needsYou > 0 ? `${needsYou} need you` : null,
    unread > 0 ? `${unread} done` : null,
    working > 0 ? `${working} working` : null,
  ].filter((part): part is string => part !== null);
  if (happening.length > 0) return happening.join(" · ");

  const parts: string[] = [];

  if (liveTerminals > 0) {
    parts.push(`${liveTerminals} ${plural(liveTerminals, "terminal")} live`);
  } else if (terminals > 0) {
    parts.push(`${terminals} ${plural(terminals, "terminal")} idle`);
  }

  if (chatPanes > 0) {
    parts.push(`${chatPanes} ${plural(chatPanes, "thread")}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "No panes yet";
}
