import type { UserQuestion } from "./question.js";


/** One hook event as recorded by the desktop's per-pane transcript ring. */
export interface TranscriptEntry {
  event: string;
  status: string;
  title: string;
  body: string;
  userPrompt: string;
  toolTarget: string;
  /** Omit diff counts when no diff applies so a read step is not displayed as a zero-line edit. */
  linesAdded?: number;
  linesRemoved?: number;
  /** Keep structured options so clients can render the runner's question without reparsing prose. */
  questions?: UserQuestion[];
  /** Pair calls and results by runner ID because tool names cannot distinguish concurrent calls. */
  toolCallId?: string;
  /** Key answers by question text so they align without depending on order. */
  answers?: Record<string, string[]>;
  /** Flag clipped replies so clients can distinguish truncation from a complete answer. */
  bodyTruncated?: boolean;
  timestamp: number;
}

export interface TranscriptResponse {
  paneId: string;
  /** Distinguish an unavailable hook pipeline from a healthy pipeline with no entries yet (contract/README.md). */
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
  /** Distinguish an unsupported runner from an unidentified one so clients can explain missing transcripts (contract/README.md). */
  transcriptOutlook?: "never" | "unknown";
  /** The runner's own conversation file the desktop read, when a hook has reported one. */
  transcriptPath?: string;
  /** Default to ring for older hosts because only file-backed history can be paged. */
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
