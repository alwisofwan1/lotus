import type { UserQuestion } from "./question.js";

/**
 * The Chat transcript as the desktop serves it — `GET /api/fleet/:pane/transcript`, passed
 * through unchanged by the mobile adapter as `GET /m/cell/:paneId/transcript`.
 *
 * Its own file because `fleet.ts` hit the 300-line ceiling the moment the Fase 3 paging
 * fields were typed (2026-08-27). Until then `transcriptOutlook`, `source`, `oldestCursor`,
 * `hasMore` and `totalEver` crossed this package untyped — they survived only because JSON
 * parsing keeps unknown keys, and nothing here could have caught a rename.
 *
 * `fleet.ts` re-exports both types, so every existing import keeps working.
 */

/** One hook event as recorded by the desktop's per-pane transcript ring. */
export interface TranscriptEntry {
  event: string;
  status: string;
  title: string;
  body: string;
  userPrompt: string;
  toolTarget: string;
  /**
   * Lines added / removed, absent when the step changed no lines.
   *
   * Absent rather than 0: "changed nothing" and "no diff applies" are different
   * claims, and a Read step must not render "+0 -0".
   */
  linesAdded?: number;
  linesRemoved?: number;
  /**
   * The questions an `AskUserQuestion` step is putting to the operator, whole.
   *
   * Present only on that step, and read from the runner's **own** record of the call — the CLI
   * writes the tool's full input to its transcript, options and descriptions included. Absent
   * everywhere else, and absent from a host too old to send it.
   *
   * It is here rather than squeezed into `toolTarget` because a question is not a target: it has
   * options, each with words of its own, and a client that has to re-parse a string to draw them
   * is a client that will draw them wrong. `bb` reaches the same shape from the other direction —
   * a question is an interaction of its own there, never a permission (`user-question-form-state.ts`).
   */
  questions?: UserQuestion[];
  /**
   * The runner's own id for the tool call this entry is about — on the call and on the result
   * answering it.
   *
   * What it buys is pairing that cannot go wrong: the two halves used to be matched by tool
   * **name**, which is all a hook drop carries, and a name cannot tell two concurrent `Bash`
   * calls apart. Absent from a hook drop and from a host too old to send it, and pairing then
   * falls back to the name as before.
   */
  toolCallId?: string;
  /**
   * What the operator chose, on the result answering an `AskUserQuestion`.
   *
   * Read out of the runner's own sentence — *`Your questions have been answered: "Q"="A"`* —
   * because that is the only record a cell with a terminal leaves of the answer. Keyed by the
   * question's own text, so it lines up with `questions` without depending on order. Absent on
   * every other result, and on a cancelled one: `event` is then `tool-post-failed`, which is the
   * word the rest of Chat already uses for a call that did not go through.
   */
  answers?: Record<string, string[]>;
  /**
   * True when `body` was cut by the 8000-byte cap on the drop payload.
   *
   * Absent means it was not. A client that renders `body` as the agent's own words
   * has to say when this is set: without it, a reply clipped mid-word is
   * indistinguishable from one that ended there. Measured 2026-08-07 at the old
   * 1000-byte cap, 15.8% of real replies were being cut this way, silently.
   */
  bodyTruncated?: boolean;
  timestamp: number;
}

export interface TranscriptResponse {
  paneId: string;
  /**
   * False when this host records nothing a client could ever read — it has no hook
   * pipeline (a Standalone Host), or it has one its own agents do not reach. Absent
   * when the pipeline is healthy, in which case an empty `entries` means this pane
   * has nothing yet, not that nothing is knowable. See `contract/README.md`.
   */
  hostSupports?: boolean;
  /** Entries returned. The ring is bounded, so this is not all of history. */
  total: number;
  entries: TranscriptEntry[];
  /**
   * `false` when the CLI behind this pane has nothing to report *with*, however healthy
   * the host is. Never `true` — absent reads as "it reports". Kept for phones built
   * before `transcriptOutlook`; new readers prefer that field.
   */
  runnerReports?: boolean;
  /**
   * The three-way answer `runnerReports` cannot give: `"never"` (this runner has nothing
   * to report with), `"unknown"` (the host could not place this pane — its pane→runner
   * map is pushed by the desktop UI and is empty after a restart), or absent when a
   * transcript is genuinely expected. `contract/README.md` carries the table.
   */
  transcriptOutlook?: "never" | "unknown";
  /** The runner's own conversation file the desktop read, when a hook has reported one. */
  transcriptPath?: string;
  /**
   * Where `entries` came from. `file` is the runner's own transcript — durable and
   * pageable; `ring` is the desktop's 60-entry in-memory hook history, which cannot be
   * paged because it slides on its own. Always sent by a desktop that has Fase 3; an
   * older desktop omits it, and that omission means `ring`.
   */
  source?: "file" | "ring";
  /** Cursor for the next page back. Absent for the ring, and when nothing older exists. */
  oldestCursor?: number;
  /** Whether older entries exist beyond this page. Absent from a desktop older than the field. */
  hasMore?: boolean;
  /**
   * Entries the source holds in total. Beside `total` rather than replacing it (ADR-4,
   * `plans/session-history-hardening`): `total` has always meant "in this response".
   */
  totalEver?: number;
}
